import { seedTenant } from './index.ts';
import { closePools } from '../db/pool.ts';

const t = await seedTenant({
  firmName: 'Sharma & Associates',
  clientName: 'Shree Ram Trading Company',
  userEmail: 'ca@sharma-associates.test',
  startYear: 2026,
});

console.log('firm    ', t.firmId);
console.log('client  ', t.clientId);
console.log('user    ', t.userId);
console.log('FY      ', t.fiscalYearId);
console.log('accounts', Object.keys(t.accounts).length);
await closePools();
