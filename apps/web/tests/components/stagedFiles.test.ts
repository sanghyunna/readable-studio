import { describe, expect, it } from 'vitest';
import { MAX_PROJECT_UPLOAD_FILE_SIZE } from '@readable-studio/contracts';
import { stageFiles } from '../../src/components/composer/stagedFiles';

function file(name: string, size = 1): File {
  const value = new File(['x'], name, { type: 'text/plain', lastModified: 1 });
  Object.defineProperty(value, 'size', { value: size });
  return value;
}

describe('home staged file contract', () => {
  it('gives duplicate and sanitizer-colliding files stable unique upload names', () => {
    const result = stageFiles([
      file('brief.pdf'), file('brief.pdf'), file('A B.txt'), file('a-b.txt'), file('é.txt'), file('é.txt'),
    ], [], 1);
    expect(result.accepted.map((item) => item.uploadName)).toEqual([
      'brief.pdf', 'brief (2).pdf', 'A B.txt', 'a-b (2).txt', 'é.txt', 'é (2).txt',
    ]);
    expect(new Set(result.accepted.map((item) => item.id)).size).toBe(6);
    expect(result.accepted.map((item) => item.file.name)).toEqual(result.accepted.map((item) => item.uploadName));
  });

  it('accepts exactly 200 MiB, rejects larger files, and does not cap selections at twelve', () => {
    const selected = Array.from({ length: 13 }, (_, index) => file(`file-${index}.txt`));
    selected.push(file('limit.bin', MAX_PROJECT_UPLOAD_FILE_SIZE));
    selected.push(file('too-large.bin', MAX_PROJECT_UPLOAD_FILE_SIZE + 1));
    const result = stageFiles(selected, [], 1);
    expect(result.accepted).toHaveLength(14);
    expect(result.accepted.at(-1)?.uploadName).toBe('limit.bin');
    expect(result.errors).toEqual(['too-large.bin: file exceeds the 200 MiB upload limit.']);
  });
});
