-- CR-001 Revision 2: a LEAD is a Party carrying the LEAD role — not a
-- separate identity. ADDITIVE only: no existing role or row is touched.
ALTER TYPE "PartyRoleType" ADD VALUE IF NOT EXISTS 'LEAD';
