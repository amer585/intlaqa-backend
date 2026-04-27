const GOVERNORATES = require('../constants/governorates');

function resolveGovCode(govCode) {
  if (govCode === undefined || govCode === null || govCode === '') return 1;
  if (/^\d+$/.test(String(govCode))) return Number(govCode);

  const governorateIndex = GOVERNORATES.indexOf(govCode);
  return governorateIndex >= 0 ? governorateIndex + 1 : 1;
}

function resolveGovName(govCode) {
  const normalizedCode = resolveGovCode(govCode);
  return GOVERNORATES[normalizedCode - 1] || govCode || null;
}

module.exports = {
  GOVERNORATES,
  resolveGovCode,
  resolveGovName,
};
