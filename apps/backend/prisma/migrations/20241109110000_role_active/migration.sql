-- IAM-001 §7/§11: roles can be DEACTIVATED. An inactive role must grant NO
-- effective permissions (PermissionsService filters on this column) while
-- keeping every user/permission link intact for re-activation. ADDITIVE only.
ALTER TABLE "roles" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT TRUE;
