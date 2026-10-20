-- Utility bills (electricity, water, piped gas) get their own Inbox class.
-- They are paid like supplier bills but are not GST tax invoices, so filing
-- them as "Other" hid them from the bill workflow. Existing rows are valid
-- under the widened checks; nothing is rewritten.
ALTER TABLE document_ai_classifications
  DROP CONSTRAINT document_ai_classifications_document_class_check;
ALTER TABLE document_ai_classifications
  ADD CONSTRAINT document_ai_classifications_document_class_check
  CHECK (document_class IN
    ('bank_statement','purchase_bill','utility_bill','sales_invoice','expense_receipt',
     'tds_document','gst_document','payroll','contract_legal','other','uncertain'));

ALTER TABLE document_class_reviews
  DROP CONSTRAINT document_class_reviews_document_class_check;
ALTER TABLE document_class_reviews
  ADD CONSTRAINT document_class_reviews_document_class_check
  CHECK (document_class IN
    ('bank_statement','purchase_bill','utility_bill','sales_invoice','expense_receipt',
     'tds_document','gst_document','payroll','contract_legal','other','uncertain'));
