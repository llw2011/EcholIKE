ALTER TYPE "usage_ledger_kind" ADD VALUE IF NOT EXISTS 'ocr_images';
ALTER TYPE "usage_ledger_kind" ADD VALUE IF NOT EXISTS 'tts_chars';
ALTER TYPE "usage_ledger_source" ADD VALUE IF NOT EXISTS 'proxy_ocr';
ALTER TYPE "usage_ledger_source" ADD VALUE IF NOT EXISTS 'proxy_tts';
