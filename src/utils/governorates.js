'use strict';

/**
 * Egyptian governorates. Kept as code (not a DB table) so adding one never
 * requires a migration. The numeric code is what we actually store in the
 * `gov_code` column; the Arabic name is resolved for display.
 */
const GOVERNORATES = Object.freeze([
  { code: '01', name: 'القاهرة' },
  { code: '02', name: 'الإسكندرية' },
  { code: '03', name: 'الجيزة' },
  { code: '04', name: 'القليوبية' },
  { code: '05', name: 'الدقهلية' },
  { code: '06', name: 'الشرقية' },
  { code: '07', name: 'الغربية' },
  { code: '08', name: 'المنوفية' },
  { code: '09', name: 'البحيرة' },
  { code: '10', name: 'كفر الشيخ' },
  { code: '11', name: 'دمياط' },
  { code: '12', name: 'بورسعيد' },
  { code: '13', name: 'الإسماعيلية' },
  { code: '14', name: 'السويس' },
  { code: '15', name: 'مطروح' },
  { code: '16', name: 'شمال سيناء' },
  { code: '17', name: 'جنوب سيناء' },
  { code: '18', name: 'بني سويف' },
  { code: '19', name: 'الفيوم' },
  { code: '20', name: 'المنيا' },
  { code: '21', name: 'أسيوط' },
  { code: '22', name: 'سوهاج' },
  { code: '23', name: 'قنا' },
  { code: '24', name: 'الأقصر' },
  { code: '25', name: 'أسوان' },
  { code: '26', name: 'البحر الأحمر' },
  { code: '27', name: 'الوادي الجديد' },
]);

const BY_CODE = new Map(GOVERNORATES.map((g) => [g.code, g.name]));
const BY_NAME = new Map(GOVERNORATES.map((g) => [g.name, g.code]));

/**
 * Accept either a code or an Arabic name and return the canonical numeric code.
 * Falls back to the raw input if unknown (so existing data isn't rejected).
 * @param {unknown} raw
 * @returns {string | null}
 */
function resolveGovCode(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const value = String(raw).trim();
  if (BY_NAME.has(value)) return BY_NAME.get(value);
  if (BY_CODE.has(value)) return value;
  return value;
}

/**
 * Resolve a stored value back to the Arabic display name.
 * @param {unknown} raw
 * @returns {string | null}
 */
function resolveGovName(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const value = String(raw).trim();
  if (BY_CODE.has(value)) return BY_CODE.get(value);
  if (BY_NAME.has(value)) return value;
  return value;
}

module.exports = { GOVERNORATES, resolveGovCode, resolveGovName };
