// User-facing error messages. Technical details (fetch/TypeError/stack/English zod text)
// never reach the UI: they go to the console, the user sees a short Russian explanation.

const HAS_CYRILLIC = /[а-яё]/i;

const BY_CODE: Record<string, string> = {
  network: 'Нет связи с сервером. Проверьте интернет и адрес сервера.',
  timeout: 'Сервер не ответил вовремя. Попробуйте ещё раз.',
  unauthorized: 'Неверный логин или пароль.',
  admin_unauthorized: 'Неверный логин или пароль администратора.',
  admin_disabled: 'Админ-панель отключена на этом сервере (не задан ADMIN_PASSWORD).',
  forbidden: 'Недостаточно прав для этого действия.',
  bad_request: 'Проверьте введённые данные.',
  not_found: 'Не найдено.',
  conflict: 'Такая запись уже существует.',
  rate_limited: 'Слишком много запросов. Подождите немного.',
  bad_match_password: 'Неверный пароль сети.',
  voice_disabled: 'Голосовая связь на сервере не настроена.',
  match_ended: 'Сеть (матч) завершена.',
  server: 'Сервер временно недоступен. Попробуйте позже.',
};

function byStatus(status: number): string | null {
  if (status === 0) return BY_CODE.network!;
  if (status === 401) return BY_CODE.unauthorized!;
  if (status === 403) return BY_CODE.forbidden!;
  if (status === 404) return BY_CODE.not_found!;
  if (status === 409) return BY_CODE.conflict!;
  if (status === 429) return BY_CODE.rate_limited!;
  if (status >= 500) return BY_CODE.server!;
  if (status >= 400) return BY_CODE.bad_request!;
  return null;
}

/** Short Russian text for a server error (code + raw message + HTTP status). */
export function friendlyMessage(code: string | undefined, message: string | undefined, status = 0): string {
  // Server texts written in Russian are already meant for the user.
  if (message && HAS_CYRILLIC.test(message) && message.length < 200) return message;
  if (code && BY_CODE[code]) return BY_CODE[code]!;
  return byStatus(status) ?? 'Что-то пошло не так. Попробуйте ещё раз.';
}

/** Converts any thrown value into a safe Russian message for the UI. */
export function friendlyError(err: unknown, fallback = 'Что-то пошло не так. Попробуйте ещё раз.'): string {
  if (err && typeof err === 'object' && 'friendly' in err && typeof (err as { friendly: unknown }).friendly === 'string') {
    return (err as { friendly: string }).friendly;
  }
  if (err instanceof DOMException && (err.name === 'AbortError' || err.name === 'TimeoutError')) return BY_CODE.timeout!;
  if (err instanceof TypeError) return BY_CODE.network!;
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (msg && HAS_CYRILLIC.test(msg) && msg.length < 200) return msg;
  if (msg) console.warn('[tactic]', err);
  return fallback;
}
