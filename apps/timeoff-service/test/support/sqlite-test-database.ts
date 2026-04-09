import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import * as path from 'node:path';

export interface SqliteTestDatabaseHandle {
  cleanup: () => void;
  databaseUrl: string;
}

export function prepareSqliteTestDatabase(
  fileName: string,
): SqliteTestDatabaseHandle {
  const repoRoot = path.resolve(__dirname, '../../../..');
  const prismaDirectory = path.join(repoRoot, 'prisma');
  const databasePath = path.join(prismaDirectory, fileName);
  const databaseUrl = `file:./${fileName}`;
  const prismaCliPath = require.resolve('prisma/build/index.js', {
    paths: [repoRoot],
  });
  const schemaPath = path.join(prismaDirectory, 'schema.prisma');
  const migrationPath = path.join(
    prismaDirectory,
    'migrations',
    '20260408213000_init',
    'migration.sql',
  );

  for (const suffix of ['', '-journal', '-shm', '-wal']) {
    const candidatePath = `${databasePath}${suffix}`;

    if (existsSync(candidatePath)) {
      rmSync(candidatePath, { force: true });
    }
  }

  execFileSync(
    process.execPath,
    [prismaCliPath, 'db', 'execute', '--schema', schemaPath, '--file', migrationPath],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
      },
      stdio: 'ignore',
    },
  );

  return {
    databaseUrl,
    cleanup: () => {
      for (const suffix of ['', '-journal', '-shm', '-wal']) {
        const candidatePath = `${databasePath}${suffix}`;

        if (existsSync(candidatePath)) {
          rmSync(candidatePath, { force: true });
        }
      }
    },
  };
}
