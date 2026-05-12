import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConsoleLogger } from "../consoleLogger.js";

describe("ConsoleLogger", () => {
  let logger: ConsoleLogger;

  beforeEach(() => {
    logger = new ConsoleLogger();
    vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("debug — forwards message and meta when provided", () => {
    const meta = { key: "value" };
    logger.debug("test message", meta);
    expect(console.debug).toHaveBeenCalledWith("test message", meta);
  });

  it("debug — forwards only message when meta is omitted", () => {
    logger.debug("test message");
    expect(console.debug).toHaveBeenCalledWith("test message");
  });

  it("info — forwards message and meta when provided", () => {
    const meta = { count: 42 };
    logger.info("info msg", meta);
    expect(console.info).toHaveBeenCalledWith("info msg", meta);
  });

  it("info — forwards only message when meta is omitted", () => {
    logger.info("info msg");
    expect(console.info).toHaveBeenCalledWith("info msg");
  });

  it("warn — forwards message and meta when provided", () => {
    const meta = { reason: "test" };
    logger.warn("warn msg", meta);
    expect(console.warn).toHaveBeenCalledWith("warn msg", meta);
  });

  it("warn — forwards only message when meta is omitted", () => {
    logger.warn("warn msg");
    expect(console.warn).toHaveBeenCalledWith("warn msg");
  });

  it("error — forwards message and meta when provided", () => {
    const meta = { code: 500 };
    logger.error("error msg", meta);
    expect(console.error).toHaveBeenCalledWith("error msg", meta);
  });

  it("error — forwards only message when meta is omitted", () => {
    logger.error("error msg");
    expect(console.error).toHaveBeenCalledWith("error msg");
  });
});
