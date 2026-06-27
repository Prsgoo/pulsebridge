import { describe, it, expect } from "vitest";
import {
  MasterKeyRequiredError,
  PluginAuthError,
  PluginInputError,
  PulseBridgeError,
  RateLimitError,
  ReauthRequiredError,
  ScopedSecretAccessError,
  SecretDecryptionError,
  TransientError,
} from "../pulseErrors.js";

describe("PulseBridgeError", () => {
  it("sets the name to PulseBridgeError", () => {
    expect(new PulseBridgeError("boom").name).toBe("PulseBridgeError");
  });

  it("preserves the message", () => {
    expect(new PulseBridgeError("boom").message).toBe("boom");
  });

  it("is an instance of Error", () => {
    expect(new PulseBridgeError("boom")).toBeInstanceOf(Error);
  });
});

describe("PluginAuthError", () => {
  it("sets the name to PluginAuthError", () => {
    expect(new PluginAuthError("denied").name).toBe("PluginAuthError");
  });

  it("extends PulseBridgeError", () => {
    expect(new PluginAuthError("denied")).toBeInstanceOf(PulseBridgeError);
  });
});

describe("ReauthRequiredError", () => {
  it("sets the name to ReauthRequiredError", () => {
    expect(new ReauthRequiredError("expired").name).toBe("ReauthRequiredError");
  });

  it("defaults the message when none is given", () => {
    expect(new ReauthRequiredError().message).toBe(
      "Plugin requires re-authentication.",
    );
  });
});

describe("RateLimitError", () => {
  it("sets the name to RateLimitError", () => {
    expect(new RateLimitError("slow down").name).toBe("RateLimitError");
  });

  it("defaults the message when none is given", () => {
    expect(new RateLimitError().message).toBe("Rate limit exceeded.");
  });

  it("exposes the provided retryAfterMs", () => {
    expect(new RateLimitError("slow down", 5_000).retryAfterMs).toBe(5_000);
  });

  it("leaves retryAfterMs undefined when not provided", () => {
    expect(new RateLimitError("slow down").retryAfterMs).toBeUndefined();
  });
});

describe("TransientError", () => {
  it("sets the name to TransientError", () => {
    expect(new TransientError("hiccup").name).toBe("TransientError");
  });

  it("defaults the message when none is given", () => {
    expect(new TransientError().message).toBe("Transient upstream error.");
  });

  it("exposes the provided retryAfterMs", () => {
    expect(new TransientError("hiccup", 2_000).retryAfterMs).toBe(2_000);
  });

  it("leaves retryAfterMs undefined when not provided", () => {
    expect(new TransientError("hiccup").retryAfterMs).toBeUndefined();
  });
});

describe("PluginInputError", () => {
  it("sets the name to PluginInputError", () => {
    expect(new PluginInputError("bad body").name).toBe("PluginInputError");
  });

  it("defaults the message when none is given", () => {
    expect(new PluginInputError().message).toBe("Invalid request payload.");
  });
});

describe("ScopedSecretAccessError", () => {
  it("sets the name to ScopedSecretAccessError", () => {
    expect(new ScopedSecretAccessError("API_KEY").name).toBe(
      "ScopedSecretAccessError",
    );
  });

  it("names the offending key in the message", () => {
    expect(new ScopedSecretAccessError("API_KEY").message).toContain("API_KEY");
  });

  it("extends PluginAuthError", () => {
    expect(new ScopedSecretAccessError("API_KEY")).toBeInstanceOf(
      PluginAuthError,
    );
  });
});

describe("MasterKeyRequiredError", () => {
  it("sets the name to MasterKeyRequiredError", () => {
    expect(new MasterKeyRequiredError("need key").name).toBe(
      "MasterKeyRequiredError",
    );
  });

  it("defaults the message when none is given", () => {
    expect(new MasterKeyRequiredError().message).toBe(
      "A master key is required to read or write secrets, but none was configured.",
    );
  });
});

describe("SecretDecryptionError", () => {
  it("sets the name to SecretDecryptionError", () => {
    expect(new SecretDecryptionError("nope").name).toBe(
      "SecretDecryptionError",
    );
  });

  it("defaults the message when none is given", () => {
    expect(new SecretDecryptionError().message).toBe(
      "Failed to decrypt secret (wrong master key or corrupted data).",
    );
  });
});
