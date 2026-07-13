import { describe, expect, test } from "bun:test";
import type { Scenario } from "./lib";
import { parseArgs, validateScenarios } from "./run";

describe("parseArgs", () => {
  test("parses --flag value and --flag=value forms", () => {
    expect(parseArgs(["--buy", "--max-price", "2", "--only", "a,b"])).toEqual({
      buy: true,
      maxPrice: 2,
      only: ["a", "b"],
    });
    expect(parseArgs(["--max-price=1.5", "--only=x"])).toEqual({
      buy: false,
      maxPrice: 1.5,
      only: ["x"],
    });
  });

  test("rejects a non-positive / non-numeric --max-price", () => {
    expect(() => parseArgs(["--max-price", "$3"])).toThrow(/max-price/);
    expect(() => parseArgs(["--max-price=0"])).toThrow(/max-price/);
  });

  test("fails closed on an unknown flag instead of ignoring it", () => {
    expect(() => parseArgs(["--maxprice=1"])).toThrow(/unknown argument/);
    expect(() => parseArgs(["--buy", "--nope"])).toThrow(/unknown argument/);
  });

  test("rejects a value on the boolean --buy flag", () => {
    expect(() => parseArgs(["--buy=false"])).toThrow(/--buy takes no value/);
    expect(() => parseArgs(["--buy=0"])).toThrow(/--buy takes no value/);
  });
});

describe("validateScenarios", () => {
  const ok: Scenario = { id: "a", url: "https://a", target: "fill" };

  test("accepts a valid scenario set", () => {
    expect(() => validateScenarios([ok])).not.toThrow();
  });

  test("rejects a bad target (which would make any level pass)", () => {
    expect(() => validateScenarios([{ ...ok, target: "filled" as never }])).toThrow(/target/);
    expect(() => validateScenarios([{ id: "b", url: "https://b" } as never])).toThrow(/target/);
  });

  test("rejects a bad expectDeadEnd and a duplicate id", () => {
    expect(() =>
      validateScenarios([{ ...ok, target: "cart", expectDeadEnd: "nope" as never }])
    ).toThrow(/expectDeadEnd/);
    expect(() => validateScenarios([ok, ok])).toThrow(/duplicate/);
  });

  test("rejects allowBuy without a positive finite price", () => {
    expect(() => validateScenarios([{ ...ok, allowBuy: true }])).toThrow(/price/);
    expect(() => validateScenarios([{ ...ok, allowBuy: true, price: -1 }])).toThrow(/price/);
    expect(() => validateScenarios([{ ...ok, price: 0 }])).toThrow(/price/);
  });

  test("rejects a non-USD or dead-end buy scenario", () => {
    expect(() => validateScenarios([{ ...ok, allowBuy: true, price: 2, currency: "GBP" }])).toThrow(
      /USD/
    );
    expect(() =>
      validateScenarios([
        { ...ok, target: "cart", allowBuy: true, price: 2, expectDeadEnd: "turnstile" },
      ])
    ).toThrow(/allowBuy and expectDeadEnd/);
  });
});
