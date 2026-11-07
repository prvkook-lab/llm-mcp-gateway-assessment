/** Fail-closed lexical redaction. Whitespace terminates a token, provider chunks do not.
 * Any token containing @ or a Unicode number is sensitive. Long tokens are suppressed
 * as soon as the bound is reached, through the next whitespace boundary.
 */
export class PiiRedactor {
  private pending = '';
  private suppressed = false;
  constructor(private readonly maxTokenChars = 4096) {
    if (!Number.isSafeInteger(maxTokenChars) || maxTokenChars < 1) throw new Error('Invalid token bound');
  }
  push(chunk: string): string {
    let output = '';
    for (const char of chunk) {
      if (/\s/u.test(char)) {
        output += this.flushToken() + char;
      } else if (!this.suppressed) {
        this.pending += char;
        if (this.pending.length >= this.maxTokenChars) {
          output += '[REDACTED]'; this.pending = ''; this.suppressed = true;
        }
      }
    }
    return output;
  }
  finish(): string { return this.flushToken(); }
  private flushToken(): string {
    if (this.suppressed) { this.suppressed = false; return ''; }
    const token = this.pending;
    this.pending = '';
    return /[@\p{N}]/u.test(token) ? '[REDACTED]' : token;
  }
}
export async function* redactStream(source: AsyncIterable<string>): AsyncGenerator<string> {
  const redactor = new PiiRedactor();
  for await (const chunk of source) {
    const safe = redactor.push(chunk);
    if (safe) yield safe;
  }
  const final = redactor.finish();
  if (final) yield final;
}
