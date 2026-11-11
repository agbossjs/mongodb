/**
 * What a store package prints of a text that may hold a connection string (agbossjs/agboss#891):
 * each whitespace-separated token with `://` keeps its scheme and user and loses everything between
 * the user's `:` and the token's LAST `@` — so a password holding `@`, `/`, `:`, `#`, `?` or `%40`
 * is masked whole (the WHATWG parser splits such a userinfo elsewhere, so it is never relied on; a
 * URL with an `@` in its path loses more than its password, never less); and every `password=`,
 * `sslpassword=` and `pass=` query parameter, up to the next `&` (a `#` or `;` in it masked too). Byte for byte the same in `@agboss/postgres` and
 * `@agboss/mongodb`, with the same tests.
 */
export function withoutPasswords(text: string): string {
  return text.split(/(\s+)/u).map(maskedToken).join("");
}

const QUERY_PASSWORD = /([?&;](?:ssl)?pass(?:word)?=)[^&\s]*/giu;

/** One token: its userinfo's password masked, then its password query parameters. */
function maskedToken(token: string): string {
  return withoutUserinfoPassword(token).replaceAll(QUERY_PASSWORD, "$1***");
}

/** `scheme://user:<anything>@rest` → `scheme://user:***@rest`, the `@` the token's last. */
function withoutUserinfoPassword(token: string): string {
  const authority = token.indexOf("://");
  if (authority === -1) return token;
  const start = authority + 3;
  const at = token.lastIndexOf("@");
  if (at < start) return token;
  const colon = token.indexOf(":", start);
  if (colon === -1 || colon > at) return token;
  return `${token.slice(0, colon)}:***${token.slice(at)}`;
}
