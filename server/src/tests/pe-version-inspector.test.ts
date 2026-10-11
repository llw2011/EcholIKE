import { describe, expect, it } from 'vitest'
import {
  createPeVersionInspector,
  matchesWindowsArtifactVersion,
} from '../services/desktop/pe-version-inspector.js'

describe('Windows PE OTA version inspector', () => {
  it('streams an installer to a private temporary file and reads both PE version facts', async () => {
    const artifact = peVersionFixture([0, 2, 13, 0])
    const inspector = createPeVersionInspector()
    const session = await inspector.open({
      expectedBytes: artifact.byteLength,
      expectedVersion: '0.2.13',
      contentLength: artifact.byteLength,
    })
    await session.write(artifact.subarray(0, 333))
    await session.write(artifact.subarray(333))

    await expect(session.finish()).resolves.toEqual({
      artifactType: 'windows-pe-installer',
      versions: {
        installerFileVersion: '0.2.13.0',
        installerProductVersion: '0.2.13.0',
      },
    })
  })

  it('normalizes the Windows trailing build component without accepting another version', () => {
    expect(
      matchesWindowsArtifactVersion('0.2.13', {
        installerFileVersion: '0.2.13.0',
        installerProductVersion: '0.2.13.0',
      }),
    ).toBe(true)
    expect(
      matchesWindowsArtifactVersion('0.2.13', {
        installerProductVersion: '0.2.14.0',
      }),
    ).toBe(false)
  })

  it('rejects a non-PE artifact and closes the inspector terminally', async () => {
    const artifact = new Uint8Array(128)
    const inspector = createPeVersionInspector()
    const session = await inspector.open({
      expectedBytes: artifact.byteLength,
      expectedVersion: '0.2.13',
      contentLength: artifact.byteLength,
    })
    await session.write(artifact)
    await expect(session.finish()).rejects.toThrow(/Windows PE/)
    await expect(session.write(new Uint8Array([1]))).rejects.toThrow(/already closed/)
  })

  it.each([0x8664, 0xaa64])(
    'rejects machine 0x%s instead of mistaking a non-NSIS shell for an x64 release proof',
    async (machine) => {
      const artifact = peVersionFixture([0, 2, 13, 0], machine)
      const inspector = createPeVersionInspector()
      const session = await inspector.open({
        expectedBytes: artifact.byteLength,
        expectedVersion: '0.2.13',
        contentLength: artifact.byteLength,
      })
      await session.write(artifact)

      await expect(session.finish()).rejects.toThrow(/PE machine/)
    },
  )
})

function peVersionFixture(version: [number, number, number, number], machine = 0x014c): Uint8Array {
  const bytes = Buffer.alloc(0x800)
  bytes.writeUInt16LE(0x5a4d, 0)
  bytes.writeUInt32LE(0x80, 0x3c)

  const pe = 0x80
  bytes.writeUInt32LE(0x00004550, pe)
  bytes.writeUInt16LE(machine, pe + 4)
  bytes.writeUInt16LE(1, pe + 6)
  bytes.writeUInt16LE(0xe0, pe + 20)

  const optional = pe + 24
  bytes.writeUInt16LE(0x010b, optional)
  bytes.writeUInt32LE(0x1000, optional + 96 + 16)
  bytes.writeUInt32LE(0x300, optional + 96 + 20)

  const section = optional + 0xe0
  bytes.write('.rsrc\0\0\0', section, 'ascii')
  bytes.writeUInt32LE(0x400, section + 8)
  bytes.writeUInt32LE(0x1000, section + 12)
  bytes.writeUInt32LE(0x400, section + 16)
  bytes.writeUInt32LE(0x400, section + 20)

  const resource = 0x400
  writeResourceDirectory(bytes, resource, 1)
  bytes.writeUInt32LE(16, resource + 16)
  bytes.writeUInt32LE(0x80000020, resource + 20)

  writeResourceDirectory(bytes, resource + 0x20, 1)
  bytes.writeUInt32LE(1, resource + 0x30)
  bytes.writeUInt32LE(0x80000040, resource + 0x34)

  writeResourceDirectory(bytes, resource + 0x40, 1)
  bytes.writeUInt32LE(1033, resource + 0x50)
  bytes.writeUInt32LE(0x60, resource + 0x54)

  bytes.writeUInt32LE(0x1100, resource + 0x60)
  bytes.writeUInt32LE(0x80, resource + 0x64)

  const versionInfo = 0x500
  const fixed = versionInfo + 0x20
  bytes.writeUInt32LE(0xfeef04bd, fixed)
  bytes.writeUInt32LE(0x00010000, fixed + 4)
  const [major, minor, patch, build] = version
  const ms = (major << 16) | minor
  const ls = (patch << 16) | build
  bytes.writeUInt32LE(ms, fixed + 8)
  bytes.writeUInt32LE(ls, fixed + 12)
  bytes.writeUInt32LE(ms, fixed + 16)
  bytes.writeUInt32LE(ls, fixed + 20)
  return bytes
}

function writeResourceDirectory(bytes: Buffer, offset: number, idEntries: number): void {
  bytes.writeUInt16LE(0, offset + 12)
  bytes.writeUInt16LE(idEntries, offset + 14)
}
