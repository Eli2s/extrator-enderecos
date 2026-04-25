export const NAME_MAX_LENGTH = 120;
export const EMAIL_MAX_LENGTH = 254;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 72;
export const CPF_LENGTH = 11;
export const DOWNLOAD_NAME_MAX_LENGTH = 80;

export function normalizeTextInput(value, maxLength) {
  return String(value ?? "").trim().slice(0, maxLength);
}

export function isWithinMaxLength(value, maxLength) {
  return String(value ?? "").trim().length <= maxLength;
}

export function normalizeEmailAddress(value) {
  return normalizeTextInput(value, EMAIL_MAX_LENGTH).toLowerCase();
}

export function isValidEmail(email) {
  const normalized = normalizeEmailAddress(email);
  if (!normalized || normalized.length > EMAIL_MAX_LENGTH) return false;
  if (normalized.includes("..")) return false;

  const parts = normalized.split("@");
  if (parts.length !== 2) return false;

  const [localPart, domain] = parts;
  if (!localPart || !domain) return false;
  if (localPart.length > 64 || domain.length > 253) return false;
  if (localPart.startsWith(".") || localPart.endsWith(".")) return false;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normalized)) return false;

  const labels = domain.split(".");
  if (labels.some((label) => !label || label.length > 63 || label.startsWith("-") || label.endsWith("-"))) {
    return false;
  }

  return true;
}

export function isValidPasswordLength(password) {
  const size = String(password ?? "").length;
  return size >= PASSWORD_MIN_LENGTH && size <= PASSWORD_MAX_LENGTH;
}
