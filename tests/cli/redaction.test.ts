import { describe, expect, it } from "vitest";
import { withoutPasswords } from "../../src/redaction.js";

describe("agbossjs/agboss#891: withoutPasswords — no password of a connection string is printed", () => {
  it.each([
    ["postgres://u:secret@h/db", "postgres://u:***@h/db"],
    ["postgres://u:p@ss@h/db", "postgres://u:***@h/db"],
    ["postgres://u:p/ss@h/db", "postgres://u:***@h/db"],
    ["postgres://u:12/ss@h/db", "postgres://u:***@h/db"],
    ["postgres://u:p:ss@h/db", "postgres://u:***@h/db"],
    ["postgres://u:p%40ss@h:5432/db", "postgres://u:***@h:5432/db"],
    ["postgres://u:p#ss@h/db", "postgres://u:***@h/db"],
    ["postgres://u:p?ss@h/db", "postgres://u:***@h/db"],
    [
      "mongodb+srv://u:secret@cluster.example.net/?w=majority",
      "mongodb+srv://u:***@cluster.example.net/?w=majority",
    ],
    [
      "mongodb://u:p@ss@h1:27017,h2:27017/db?replicaSet=rs0",
      "mongodb://u:***@h1:27017,h2:27017/db?replicaSet=rs0",
    ],
    ["postgres://h/db?user=u&password=secret&x=1", "postgres://h/db?user=u&password=***&x=1"],
    ["postgres://h/db?sslpassword=secret", "postgres://h/db?sslpassword=***"],
    ["mongodb://h/db?pass=secret", "mongodb://h/db?pass=***"],
    ["postgres://h/db?password=ab#cd", "postgres://h/db?password=***"],
    ["postgres://h/db?sslpassword=ab#cd&x=1", "postgres://h/db?sslpassword=***&x=1"],
    ["mongodb://h/db?w=1&pass=ab;cd#ef", "mongodb://h/db?w=1&pass=***"],
    [
      "failed: connect postgres://u:secret@h/db (refused)",
      "failed: connect postgres://u:***@h/db (refused)",
    ],
    [
      "from mongodb://a:secret@h1/x to postgres://b:p@ss@h2/y",
      "from mongodb://a:***@h1/x to postgres://b:***@h2/y",
    ],
  ])("%s", (text, masked) => {
    expect(withoutPasswords(text)).toBe(masked);
    expect(withoutPasswords(text)).not.toMatch(
      /secret|p@ss|p\/ss|12\/ss|p:ss|p%40ss|p#ss|p\?ss|cd/u,
    );
  });

  it("a text with no connection string is kept as it is", () => {
    expect(withoutPasswords("schema t_1 is at migration 29")).toBe("schema t_1 is at migration 29");
    expect(withoutPasswords("mail me at u@h, ok")).toBe("mail me at u@h, ok");
    expect(withoutPasswords("mongodb://h1,h2/db?replicaSet=rs0")).toBe(
      "mongodb://h1,h2/db?replicaSet=rs0",
    );
  });

  it("a password of any printable characters never comes out (500 seeded draws)", () => {
    const printable = Array.from({ length: 94 }, (_, at) => String.fromCharCode(33 + at)).join("");
    let seed = 891;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    const leaks: string[] = [];
    for (let draw = 0; draw < 500; draw += 1) {
      const length = 8 + (next() % 16);
      const password = Array.from({ length }, () => printable[next() % printable.length]).join("");
      const text = `failed on mongodb://app:${password}@h1:27017,h2:27017/agboss?replicaSet=rs0 now`;
      // a query parameter's password ends at the next "&" (that is how a URL is read)
      const value = password.replaceAll("&", "");
      const query = `failed on mongodb://h1,h2/agboss?replicaSet=rs0&password=${value} now`;
      if (withoutPasswords(text).includes(password)) leaks.push(password);
      if (value.length >= 8 && withoutPasswords(query).includes(value)) leaks.push(value);
    }

    expect(leaks).toEqual([]);
  });
});
