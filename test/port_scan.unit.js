import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { PortManager } from "../src/hub-server/ports.js";

test("scan drops ports that disappear", async () => {
  let ports = [{ path: "/dev/ttyACM0" }, { path: "/dev/ttyACM1" }];
  const mgr = new PortManager({
    dataDir: path.join(os.tmpdir(), "shub-scan-test"),
    listPorts: async () => ports,
  });
  await mgr.scan();
  assert.deepEqual(
    mgr
      .list()
      .map((p) => p.id)
      .sort(),
    ["ttyACM0", "ttyACM1"],
  );
  ports = [{ path: "/dev/ttyACM1" }];
  await mgr.scan();
  assert.deepEqual(
    mgr.list().map((p) => p.id),
    ["ttyACM1"],
  );
});
