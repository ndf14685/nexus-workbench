import { describe, expect, it } from "vitest";
import { resolveTerminalOsIdentity } from "./terminal-identity";

describe("resolveTerminalOsIdentity", () => {
    it("honors an explicit connection environment over a hostname hint", () => {
        expect(resolveTerminalOsIdentity("ssh://ubuntu-host", "debian", null)).toBe("debian");
    });

    it("recognizes Ubuntu and Debian names without probing a remote shell", () => {
        expect(resolveTerminalOsIdentity("ssh://ubuntu-build", null, null)).toBe("ubuntu");
        expect(resolveTerminalOsIdentity("wsl://Debian", null, null)).toBe("debian");
    });

    it("keeps an unidentified remote connection neutral", () => {
        expect(resolveTerminalOsIdentity("ssh://192.168.1.10", null, null)).toBe("neutral");
    });
});
