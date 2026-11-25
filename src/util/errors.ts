export class KappaError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'KappaError';
    this.code = code;
  }
}
/** Node's fetch reports every network failure as "fetch failed"; the useful part (ENOTFOUND, UND_ERR_CONNECT_TIMEOUT, ...) is in `cause`. */
export const errMsg = (e: unknown): string => {
  if (!(e instanceof Error)) return String(e);
  const c = (e as { cause?: { code?: string; message?: string } }).cause;
  const why = c?.code || c?.message;
  return why && !e.message.includes(why) ? `${e.message} (${why})` : e.message;
};