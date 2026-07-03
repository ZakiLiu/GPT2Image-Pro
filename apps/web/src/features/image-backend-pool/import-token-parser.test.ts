import { describe, expect, it } from "vitest";

import { parseImportTokensText } from "./import-token-parser";

const jwtA = `${"a".repeat(24)}.${"b".repeat(48)}.${"c".repeat(48)}`;
const jwtB = `${"e".repeat(24)}.${"f".repeat(48)}.${"g".repeat(48)}`;

describe("image backend import token parser", () => {
  it("parses one access token per line", () => {
    const result = parseImportTokensText(`${jwtA}\n${jwtB}`, {
      plainFallback: "access",
    });

    expect(result.accessTokens).toEqual([jwtA, jwtB]);
    expect(result.refreshTokens).toEqual([]);
  });

  it("parses bearer access token lines with quotes and commas", () => {
    const result = parseImportTokensText(`"Bearer ${jwtA}",\nBearer ${jwtB}`, {
      plainFallback: "access",
    });

    expect(result.accessTokens).toEqual([jwtA, jwtB]);
  });

  it("parses access tokens from auth session JSON", () => {
    const result = parseImportTokensText(
      JSON.stringify({
        accessToken: jwtA,
        sessionToken: "not-an-access-token",
      }),
      { plainFallback: "access" }
    );

    expect(result.accessTokens).toEqual([jwtA]);
  });

  it("parses JSON arrays of access tokens", () => {
    const result = parseImportTokensText(JSON.stringify([jwtA, jwtB]), {
      plainFallback: "access",
    });

    expect(result.accessTokens).toEqual([jwtA, jwtB]);
  });

  it("extracts eyJ JWT access tokens regardless of separator", () => {
    const atA = `eyJ${"a".repeat(24)}.${"b".repeat(48)}.${"c".repeat(48)}`;
    const atB = `eyJ${"d".repeat(24)}.${"e".repeat(48)}.${"f".repeat(48)}`;

    // 无分隔粘连。
    expect(
      parseImportTokensText(`${atA}${atB}`, { plainFallback: "access" })
        .accessTokens
    ).toEqual([atA, atB]);

    // 非常规分隔符(竖线)。
    expect(
      parseImportTokensText(`${atA}|${atB}`, { plainFallback: "access" })
        .accessTokens
    ).toEqual([atA, atB]);

    // 混在文本里(label= / label:)。
    expect(
      parseImportTokensText(`token1=${atA}\ntoken2: ${atB}`, {
        plainFallback: "access",
      }).accessTokens
    ).toEqual([atA, atB]);
  });
});
