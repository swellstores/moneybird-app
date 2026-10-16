import { describe, it, expect } from "vitest";
import { createSwellClient } from "../helpers/swell-client";

describe("Store settings (read-only)", () => {
  it("loads general store settings using CLI auth", async () => {
    const swell = createSwellClient();

    const general = await swell.get("/settings/general");

    expect(general).toBeDefined();
    expect(general.id).toBe("general");
    expect(general.features).toBeDefined();
    expect(typeof general.features.carts).toBe("boolean");
  });
});
