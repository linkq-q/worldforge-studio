import { access, cp, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const dataDir = resolve(process.env.WORLDFORGE_DATA_DIR ?? join('data', 'map-editor'));
  const output = resolve(process.argv[2] ?? join('data', 'backups', `map-editor-${dateStamp()}`));
  await access(dataDir);
  await assertDoesNotExist(output);
  await mkdir(dirname(output), { recursive: true });
  await cp(dataDir, output, { recursive: true, errorOnExist: true });
  console.log(output);
}

async function assertDoesNotExist(file: string): Promise<void> {
  try {
    await access(file);
    throw new Error(`backup_output_exists:${file}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('backup_output_exists:')) throw error;
  }
}

function dateStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
