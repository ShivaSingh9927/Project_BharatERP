import { closePools } from '../db/pool.ts';
import { importArchivedEmails, r2EmailConfig } from './cloudflareR2Email.ts';

const config = r2EmailConfig();
if (!config) {
  console.error('Configure the CLOUDFLARE_R2_* email environment variables first.');
  process.exitCode = 1;
} else {
  try {
    const summary = await importArchivedEmails(config);
    console.log(JSON.stringify(summary, null, 2));
    if (summary.failures.length) process.exitCode = 1;
  } catch (error) {
    console.error('Email import failed:', (error as Error).message);
    process.exitCode = 1;
  } finally {
    await closePools();
  }
}
