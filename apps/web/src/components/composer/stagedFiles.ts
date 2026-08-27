import { MAX_PROJECT_UPLOAD_FILE_SIZE } from '@readable-studio/contracts';

export interface StagedFileItem {
  id: string;
  originalName: string;
  uploadName: string;
  file: File;
  previewUrl: string | null;
}

export interface StageFilesResult {
  accepted: StagedFileItem[];
  errors: string[];
  nextId: number;
}

/** Mirrors the daemon's upload-name sanitizer for collision detection. */
export function sanitizeUploadName(raw: string): string {
  const cleaned = raw
    .normalize('NFC')
    .replace(/[\\/]/g, '_')
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}._-]/gu, '_')
    .replace(/^\.+/, '_')
    .trim();
  return cleaned || 'file';
}

function collisionKey(name: string): string {
  return sanitizeUploadName(name).normalize('NFC').toLocaleLowerCase('en-US');
}

function disambiguatedName(originalName: string, ordinal: number): string {
  if (ordinal === 1) return originalName;
  const dot = originalName.lastIndexOf('.');
  const hasExtension = dot > 0 && dot < originalName.length - 1;
  const stem = hasExtension ? originalName.slice(0, dot) : originalName;
  const extension = hasExtension ? originalName.slice(dot) : '';
  return `${stem} (${ordinal})${extension}`;
}

export function stageFiles(
  selected: File[],
  existing: StagedFileItem[],
  firstId: number,
): StageFilesResult {
  const used = new Set(existing.map((item) => collisionKey(item.uploadName)));
  const accepted: StagedFileItem[] = [];
  const errors: string[] = [];
  let nextId = firstId;

  for (const source of selected) {
    if (source.size > MAX_PROJECT_UPLOAD_FILE_SIZE) {
      errors.push(`${source.name}: file exceeds the 200 MiB upload limit.`);
      continue;
    }

    let ordinal = 1;
    let uploadName = disambiguatedName(source.name.normalize('NFC'), ordinal);
    while (used.has(collisionKey(uploadName))) {
      ordinal += 1;
      uploadName = disambiguatedName(source.name.normalize('NFC'), ordinal);
    }
    used.add(collisionKey(uploadName));

    const file = new File([source], uploadName, {
      type: source.type,
      lastModified: source.lastModified,
    });
    accepted.push({
      id: `staged-file-${nextId}`,
      originalName: source.name,
      uploadName,
      file,
      previewUrl: null,
    });
    nextId += 1;
  }

  return { accepted, errors, nextId };
}
