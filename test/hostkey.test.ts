import { describe, expect, it } from "vitest";
import { generateHostKey, generatePasscode } from "../src/hostkey.js";

describe("host keys and passcodes", () => {
  it("makes 6-digit host keys", () => {
    for (let i = 0; i < 50; i++) expect(generateHostKey()).toMatch(/^\d{6}$/);
  });

  it("makes passcodes of 6 to 10 characters", () => {
    expect(generatePasscode()).toMatch(/^[A-Za-z0-9]{8}$/);
    expect(generatePasscode(6)).toHaveLength(6);
    expect(generatePasscode(10)).toHaveLength(10);
    expect(() => generatePasscode(11)).toThrow();
  });
});
