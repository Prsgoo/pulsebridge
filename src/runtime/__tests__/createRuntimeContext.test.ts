import { describe, it, expect } from "vitest";
import { createRuntimeContext } from "../createRuntimeContext.js";
import { InMemoryStateStore } from "../../storage/inMemoryStateStore.js";
import { InMemoryTokenStore } from "../../contracts/tokens/inMemoryTokenStore.js";

describe("createRuntimeContext", () => {
  it("provides a default logger when none is given", () => {
    expect(createRuntimeContext().logger).toBeDefined();
  });

  it("provides a default secret store when none is given", () => {
    expect(createRuntimeContext().secrets).toBeDefined();
  });

  it("now() returns a Date", () => {
    expect(createRuntimeContext().now()).toBeInstanceOf(Date);
  });

  it("omits tokens when none is provided", () => {
    expect("tokens" in createRuntimeContext()).toBe(false);
  });

  it("omits stateStore when none is provided", () => {
    expect("stateStore" in createRuntimeContext()).toBe(false);
  });

  it("passes through the provided token store", () => {
    const tokens = new InMemoryTokenStore();
    expect(createRuntimeContext({ tokens }).tokens).toBe(tokens);
  });

  it("passes through the provided state store", () => {
    const stateStore = new InMemoryStateStore();
    expect(createRuntimeContext({ stateStore }).stateStore).toBe(stateStore);
  });
});
