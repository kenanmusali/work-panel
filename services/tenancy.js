// tenancy.js — resolves where a department's ("group") data lives.
//
// The DEFAULT tenant keeps the ORIGINAL paths (data/diagrams, data/files,
// data/settings.json) so every existing diagram / PDF keeps working with zero
// migration. Every NEW department gets its own isolated tree under
// data/tenants/<id>/… — its own diagrams, PDFs and settings.

const ROOT = () => (process.env.DATA_PATH || 'data').replace(/^\/|\/$/g, '');

export const DEFAULT_TENANT = 'main';

export function tenantOf(req) {
  return (req && req.user && req.user.tenantId) || DEFAULT_TENANT;
}

// Base folder for a tenant's content.
export function tenantBase(tenantId) {
  const tid = tenantId || DEFAULT_TENANT;
  return tid === DEFAULT_TENANT ? ROOT() : `${ROOT()}/tenants/${tid}`;
}
