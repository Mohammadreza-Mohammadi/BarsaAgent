const TOKEN_PATTERNS = [
  /\b(?:sk|ghp|github_pat|xox[baprs])[-_A-Za-z0-9.]{12,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{8,})?\b/g,
  /\b(?:bearer|authorization|api[-_ ]?key|oauth[-_ ]?token|access[-_ ]?token|token)\s*[:=]\s*[^\s,;]+/gi
];

export function environmentSecrets(env = process.env) {
  const names = Object.keys(env).filter(name => /(TOKEN|API[_-]?KEY|SECRET|PASSWORD|OAUTH)/i.test(name));
  return names.map(name => env[name]).filter(value => typeof value === 'string' && value.length >= 6);
}

export function redact(value, secrets = environmentSecrets()) {
  let text = String(value ?? '');
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join('[MASKED]');
  }
  for (const pattern of TOKEN_PATTERNS) text = text.replace(pattern, '[MASKED]');
  return text;
}
