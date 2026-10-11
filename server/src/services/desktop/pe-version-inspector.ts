import { mkdtemp, open, rm, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  OtaArtifactInspectorContext,
  OtaArtifactInspectorResult,
  OtaArtifactInspectorSession,
  OtaArtifactVersionInspector,
  OtaArtifactValidationErrorCode,
} from './ota-artifact-validator.js'

const PE_SIGNATURE = 0x00004550
// Tauri's x64 NSIS bundle uses the standard PE32/i386 NSIS launcher. The signed
// `_x64-setup.exe` publication name identifies the payload dimension; this outer
// machine field must not be misrepresented as the embedded application architecture.
const NSIS_LAUNCHER_MACHINE = 0x014c
const PE32_MAGIC = 0x010b
const RESOURCE_DIRECTORY_INDEX = 2
const RT_VERSION = 16
const VERSION_FIXED_INFO_SIGNATURE = 0xfeef04bd
const MAX_PE_SECTIONS = 96
const MAX_RESOURCE_DIRECTORY_ENTRIES = 4096
const MAX_VERSION_RESOURCE_BYTES = 1024 * 1024

export function createPeVersionInspector(): OtaArtifactVersionInspector {
  return {
    async open(context) {
      return createSession(context)
    },
  }
}

export function matchesWindowsArtifactVersion(
  expectedVersion: string,
  facts: Readonly<Record<string, string>>,
): boolean {
  const expected = normalizedVersion(expectedVersion)
  const versions = Object.values(facts)
  return versions.length > 0 && versions.every((version) => normalizedVersion(version) === expected)
}

async function createSession(
  context: OtaArtifactInspectorContext,
): Promise<OtaArtifactInspectorSession> {
  const directory = await mkdtemp(join(tmpdir(), 'echolike-ota-'))
  const path = join(directory, 'artifact.exe')
  const handle = await open(path, 'wx+', 0o600)
  let position = 0
  let finished = false

  const cleanup = async () => {
    await handle.close().catch(() => undefined)
    await rm(directory, { recursive: true, force: true }).catch(() => undefined)
  }

  return {
    async write(chunk) {
      if (finished) throw new Error('OTA artifact inspector is already closed')
      if (position + chunk.byteLength > context.expectedBytes) {
        throw new Error('OTA artifact inspector received more bytes than declared')
      }
      const result = await handle.write(chunk, 0, chunk.byteLength, position)
      if (result.bytesWritten !== chunk.byteLength) {
        throw new Error('OTA artifact inspector could not persist the complete chunk')
      }
      position += result.bytesWritten
    },
    async finish(): Promise<OtaArtifactInspectorResult> {
      if (finished) throw new Error('OTA artifact inspector is already closed')
      finished = true
      try {
        if (position !== context.expectedBytes) {
          throw new Error('OTA artifact inspector received an incomplete artifact')
        }
        await handle.sync()
        const versions = await readPeVersionFacts(handle, context.expectedBytes)
        return { artifactType: 'windows-pe-installer', versions }
      } finally {
        await cleanup()
      }
    },
    async abort(_reason: OtaArtifactValidationErrorCode) {
      if (finished) return
      finished = true
      await cleanup()
    },
  }
}

async function readPeVersionFacts(
  handle: FileHandle,
  fileSize: number,
): Promise<Record<string, string>> {
  const dos = await readExactly(handle, fileSize, 0, 64)
  if (dos.readUInt16LE(0) !== 0x5a4d) throw new Error('Artifact is not a Windows PE file')
  const peOffset = dos.readUInt32LE(0x3c)
  const peHeader = await readExactly(handle, fileSize, peOffset, 24)
  if (peHeader.readUInt32LE(0) !== PE_SIGNATURE) throw new Error('PE signature is invalid')
  if (peHeader.readUInt16LE(4) !== NSIS_LAUNCHER_MACHINE) {
    throw new Error('PE machine is not the expected NSIS launcher architecture')
  }

  const sectionCount = peHeader.readUInt16LE(6)
  const optionalHeaderSize = peHeader.readUInt16LE(20)
  if (sectionCount < 1 || sectionCount > MAX_PE_SECTIONS) {
    throw new Error('PE section count is invalid')
  }
  const optionalHeader = await readExactly(handle, fileSize, peOffset + 24, optionalHeaderSize)
  const magic = optionalHeader.readUInt16LE(0)
  const dataDirectoryOffset = magic === PE32_MAGIC ? 96 : -1
  const resourceEntryOffset = dataDirectoryOffset + RESOURCE_DIRECTORY_INDEX * 8
  if (dataDirectoryOffset < 0 || resourceEntryOffset + 8 > optionalHeader.byteLength) {
    throw new Error('PE optional header has no resource directory')
  }
  const resourceRva = optionalHeader.readUInt32LE(resourceEntryOffset)
  const resourceSize = optionalHeader.readUInt32LE(resourceEntryOffset + 4)
  if (!resourceRva || !resourceSize) throw new Error('PE version resource is missing')

  const sectionTableOffset = peOffset + 24 + optionalHeaderSize
  const sectionTable = await readExactly(handle, fileSize, sectionTableOffset, sectionCount * 40)
  const sections = Array.from({ length: sectionCount }, (_, index) => {
    const offset = index * 40
    return {
      virtualSize: sectionTable.readUInt32LE(offset + 8),
      virtualAddress: sectionTable.readUInt32LE(offset + 12),
      rawSize: sectionTable.readUInt32LE(offset + 16),
      rawOffset: sectionTable.readUInt32LE(offset + 20),
    }
  })
  const rvaToOffset = (rva: number): number => {
    const section = sections.find((candidate) => {
      const size = Math.max(candidate.virtualSize, candidate.rawSize)
      return rva >= candidate.virtualAddress && rva < candidate.virtualAddress + size
    })
    if (!section) throw new Error('PE resource RVA is outside every section')
    const offset = section.rawOffset + (rva - section.virtualAddress)
    if (offset < 0 || offset >= fileSize) throw new Error('PE resource offset is invalid')
    return offset
  }

  const resourceBase = rvaToOffset(resourceRva)
  const typeDirectory = await resourceChildDirectory(handle, fileSize, resourceBase, 0, RT_VERSION)
  const nameDirectory = await firstResourceChildDirectory(
    handle,
    fileSize,
    resourceBase,
    typeDirectory,
  )
  const dataEntryRelative = await firstResourceDataEntry(
    handle,
    fileSize,
    resourceBase,
    nameDirectory,
  )
  const dataEntry = await readExactly(handle, fileSize, resourceBase + dataEntryRelative, 16)
  const versionRva = dataEntry.readUInt32LE(0)
  const versionSize = dataEntry.readUInt32LE(4)
  if (
    versionSize < 24 ||
    versionSize > MAX_VERSION_RESOURCE_BYTES ||
    versionSize > resourceSize ||
    versionSize > fileSize
  ) {
    throw new Error('PE version resource size is invalid')
  }
  const versionBlob = await readExactly(handle, fileSize, rvaToOffset(versionRva), versionSize)
  return fixedFileVersionFacts(versionBlob)
}

async function resourceChildDirectory(
  handle: FileHandle,
  fileSize: number,
  base: number,
  directoryRelative: number,
  id: number,
): Promise<number> {
  const entries = await resourceDirectoryEntries(handle, fileSize, base, directoryRelative)
  const entry = entries.find((candidate) => !candidate.named && candidate.id === id)
  if (!entry || !entry.directory) throw new Error('PE version resource type is missing')
  return entry.offset
}

async function firstResourceChildDirectory(
  handle: FileHandle,
  fileSize: number,
  base: number,
  directoryRelative: number,
): Promise<number> {
  const entries = await resourceDirectoryEntries(handle, fileSize, base, directoryRelative)
  const entry = entries.find((candidate) => candidate.directory)
  if (!entry) throw new Error('PE version resource name directory is missing')
  return entry.offset
}

async function firstResourceDataEntry(
  handle: FileHandle,
  fileSize: number,
  base: number,
  directoryRelative: number,
): Promise<number> {
  const entries = await resourceDirectoryEntries(handle, fileSize, base, directoryRelative)
  for (const entry of entries) {
    if (!entry.directory) return entry.offset
    const nested = await resourceDirectoryEntries(handle, fileSize, base, entry.offset)
    const data = nested.find((candidate) => !candidate.directory)
    if (data) return data.offset
  }
  throw new Error('PE version resource data entry is missing')
}

async function resourceDirectoryEntries(
  handle: FileHandle,
  fileSize: number,
  base: number,
  relative: number,
): Promise<Array<{ named: boolean; id: number; directory: boolean; offset: number }>> {
  const header = await readExactly(handle, fileSize, base + relative, 16)
  const count = header.readUInt16LE(12) + header.readUInt16LE(14)
  if (count < 1 || count > MAX_RESOURCE_DIRECTORY_ENTRIES) {
    throw new Error('PE resource directory entry count is invalid')
  }
  const rows = await readExactly(handle, fileSize, base + relative + 16, count * 8)
  return Array.from({ length: count }, (_, index) => {
    const name = rows.readUInt32LE(index * 8)
    const target = rows.readUInt32LE(index * 8 + 4)
    return {
      named: Boolean(name & 0x80000000),
      id: name & 0xffff,
      directory: Boolean(target & 0x80000000),
      offset: target & 0x7fffffff,
    }
  })
}

function fixedFileVersionFacts(blob: Buffer): Record<string, string> {
  const signature = Buffer.allocUnsafe(4)
  signature.writeUInt32LE(VERSION_FIXED_INFO_SIGNATURE)
  let offset = blob.indexOf(signature)
  while (offset >= 0) {
    if (offset + 24 <= blob.byteLength) {
      const fileVersion = versionFromWords(
        blob.readUInt32LE(offset + 8),
        blob.readUInt32LE(offset + 12),
      )
      const productVersion = versionFromWords(
        blob.readUInt32LE(offset + 16),
        blob.readUInt32LE(offset + 20),
      )
      if (fileVersion && productVersion) {
        return { installerFileVersion: fileVersion, installerProductVersion: productVersion }
      }
    }
    offset = blob.indexOf(signature, offset + 1)
  }
  throw new Error('PE fixed version information is missing')
}

function versionFromWords(ms: number, ls: number): string | null {
  const parts = [ms >>> 16, ms & 0xffff, ls >>> 16, ls & 0xffff]
  return parts.some((part) => part !== 0) ? parts.join('.') : null
}

function normalizedVersion(value: string): string {
  const parts = value.trim().replace(/^v/i, '').split('.')
  while (parts.length > 1 && parts.at(-1) === '0') parts.pop()
  return parts.join('.')
}

async function readExactly(
  handle: FileHandle,
  fileSize: number,
  position: number,
  length: number,
): Promise<Buffer> {
  if (
    !Number.isSafeInteger(position) ||
    !Number.isSafeInteger(length) ||
    position < 0 ||
    length < 0 ||
    position + length > fileSize
  ) {
    throw new Error('PE read is outside the artifact')
  }
  const buffer = Buffer.alloc(length)
  const result = await handle.read(buffer, 0, length, position)
  if (result.bytesRead !== length) throw new Error('PE artifact ended unexpectedly')
  return buffer
}
