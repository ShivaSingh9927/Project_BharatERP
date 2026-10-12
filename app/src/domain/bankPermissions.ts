/**
 * Bank workflow capabilities for the current signed-in user's role.
 * Reads are client-scoped separately; this module only answers role rights.
 */
export type BankCapability = 'read' | 'import' | 'review' | 'confirm' | 'manage_settings';

const grants: Record<BankCapability, ReadonlySet<string>> = {
  read: new Set(['owner', 'ca_partner', 'ca_staff', 'auditor']),
  // Importing statement evidence and saving a non-posting review do not create
  // ledger entries. CA staff can prepare this work for an authorized confirmer.
  import: new Set(['owner', 'ca_partner', 'ca_staff']),
  review: new Set(['owner', 'ca_partner', 'ca_staff']),
  // These actions reconcile or post accounting entries. Do not delegate them
  // to staff or auditor roles until the app has an explicit approval workflow.
  confirm: new Set(['owner', 'ca_partner']),
  // Account setup and firm-wide AI sharing preferences affect more than a
  // single transaction, so require the owner or CA partner.
  manage_settings: new Set(['owner', 'ca_partner']),
};

export function hasBankCapability(role: string, capability: BankCapability): boolean {
  return grants[capability].has(role);
}

const reviewOnlyClassifications = new Set([
  'unsure', 'share_application_pending', 'related_party_loan_pending',
  'customer_advance_pending', 'intercompany_transfer_pending',
  'refund_or_reversal_pending', 'bank_interest_pending', 'customer_receipt_pending',
]);

/** Unknown classifications fail closed as confirmation actions. */
export function bankClassificationCapability(classification: unknown): BankCapability {
  return typeof classification === 'string' && reviewOnlyClassifications.has(classification)
    ? 'review' : 'confirm';
}
