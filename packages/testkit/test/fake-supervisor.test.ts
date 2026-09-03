import { describe, expect, it } from "vitest";
import { OmniError, type SpawnSpec } from "@omni-acp/protocol";
import { fakeSupervisor, scriptedAgent, type FakeAgentProcess } from "@omni-acp/testkit";

const spec = (over?: Partial<SpawnSpec>): SpawnSpec => ({
  command: process.execPath,
  args: ["agent.js"],
  cwd: "/tmp",
  env: { PATH: "/usr/bin" },
  ...over,
});

const WINDOWS_OWNERSHIP = {
  kind: "windows-taskkill-tree",
  confirmsTreeGone: false,
  survivesDaemonKill: true,
  caveat: "taskkill /T cannot prove the tree is gone",
} as const;

describe("fakeSupervisor", () => {
  it("records the SpawnSpec it was handed, verbatim", async () => {
    const sup = fakeSupervisor();
    const s = spec({ label: "example" });
    const p = await sup.spawn(s);
    expect(sup.spawnCalls).toEqual([s]);
    expect(p.info.command).toBe(process.execPath);
    expect(p.info.argsRedacted).toEqual(["agent.js"]);
    expect(p.info.groupId).toBe(p.pid); // POSIX: pgid == pid
    expect(sup.live.size).toBe(1);
    await p.terminate({ force: true });
  });

  it("wires the enqueued ScriptedAgent's stream, in order", async () => {
    const sup = fakeSupervisor();
    const first = scriptedAgent({ name: "first" });
    const second = scriptedAgent({ name: "second" });
    sup.enqueue(first);
    sup.enqueue(second);
    expect((await sup.spawn(spec())).stream).toBe(first.stream);
    expect((await sup.spawn(spec())).stream).toBe(second.stream);
    await sup.shutdown();
  });

  it("wires a fresh agent when nothing is enqueued, so a lifecycle test need not care", async () => {
    const sup = fakeSupervisor();
    const p = await sup.spawn(spec());
    expect(p.stream.readable).toBeInstanceOf(ReadableStream);
    await sup.shutdown();
  });

  it("fails the spawn on demand, which is the spawn_failed path", async () => {
    const sup = fakeSupervisor();
    const boom = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    sup.enqueue({ failWith: boom });
    await expect(sup.spawn(spec())).rejects.toBe(boom);
    expect(sup.live.size).toBe(0);
    expect(sup.allTreesReclaimed()).toBe(true);
  });

  it("rejects a spawn whose signal is already aborted, as agent_timeout", async () => {
    const sup = fakeSupervisor();
    const ac = new AbortController();
    ac.abort();
    await expect(sup.spawn(spec(), ac.signal)).rejects.toBeInstanceOf(OmniError);
    await expect(sup.spawn(spec(), ac.signal)).rejects.toMatchObject({ code: "agent_timeout" });
  });

  it("terminates once however many callers ask, and hands every caller one outcome", async () => {
    const sup = fakeSupervisor();
    const p = (await sup.spawn(spec())) as FakeAgentProcess;
    const [a, b, c] = await Promise.all([
      p.terminate({ force: true }),
      p.terminate({ force: true }),
      p.terminate(),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a.leaderExited).toBe(true);
    expect(a.treeGone).toBe(true);
    expect(a.escalatedTo).toBe("sigkill");
    expect(p.terminateCalls).toHaveLength(3);
    expect(sup.live.size).toBe(0);
    expect(sup.allTreesReclaimed()).toBe(true);
  });

  it("reports already_exited when the agent died first", async () => {
    const sup = fakeSupervisor();
    const p = (await sup.spawn(spec())) as FakeAgentProcess;
    p.simulateExit(1, null);
    const exit = await p.exited;
    expect(exit).toMatchObject({ code: 1, signal: null, requested: false });
    await p.stdoutEnded; // resolves too: the transport dies with the process
    expect(p.pid).toBeNull();

    const outcome = await p.terminate();
    expect(outcome.escalatedTo).toBe("already_exited");
    expect(outcome.leaderExited).toBe(true);
  });

  it("never claims treeGone on Windows ownership (D10)", async () => {
    const sup = fakeSupervisor({ ownership: WINDOWS_OWNERSHIP });
    expect(sup.platform.ownership.confirmsTreeGone).toBe(false);
    expect(sup.platform.spawnOptions({ windowsHide: true })).toEqual({
      detached: false,
      windowsHide: true,
    });
    const p = (await sup.spawn(spec())) as FakeAgentProcess;
    expect(p.info.groupId).toBeNull(); // no addressable group on Windows
    const outcome = await p.terminate({ force: true });
    expect(outcome.treeGone).toBe(false);
    expect(outcome.leaderExited).toBe(true);
    expect(outcome.escalatedTo).toBe("taskkill");
  });

  it("chooses POSIX spawn options for POSIX ownership", () => {
    expect(fakeSupervisor().platform.spawnOptions({ windowsHide: true })).toEqual({
      detached: true,
      windowsHide: false,
    });
  });

  it("keeps a stderr tail with line callbacks and a finalize() flush", async () => {
    const sup = fakeSupervisor();
    const p = (await sup.spawn(spec())) as FakeAgentProcess;
    const lines: string[] = [];
    const off = p.stderr.onLine((l) => lines.push(l));
    p.writeStderr("first line\nsecond ");
    p.writeStderr("line\ntrailing without newline");
    expect(lines).toEqual(["first line", "second line"]);
    expect(p.stderr.snapshot()).toContain("trailing without newline");

    p.stderr.finalize();
    expect(lines).toEqual(["first line", "second line", "trailing without newline"]);
    p.stderr.finalize(); // idempotent
    expect(lines).toHaveLength(3);
    off();
    p.writeStderr("after unsubscribe\n");
    expect(lines).toHaveLength(3);
    await p.terminate({ force: true });
  });

  it("caps the stderr tail in BYTES and hides a partial leading rune", async () => {
    const sup = fakeSupervisor();
    const p = (await sup.spawn(spec({ stderrTailBytes: 16 }))) as FakeAgentProcess;
    p.writeStderr("ノイズ".repeat(4)); // 12 runes, 36 bytes
    const snap = p.stderr.snapshot();
    expect(Buffer.byteLength(snap, "utf8")).toBeLessThanOrEqual(16);
    // 16 bytes hold 5 whole 3-byte runes; the 6th is partial and must not surface as U+FFFD.
    expect(snap).toBe("イズノイズ");
    expect(snap).not.toContain("\uFFFD");
    await p.terminate({ force: true });
  });

  it("shutdown() reclaims every live tree", async () => {
    const sup = fakeSupervisor();
    await sup.spawn(spec());
    await sup.spawn(spec());
    expect(sup.live.size).toBe(2);
    expect(sup.allTreesReclaimed()).toBe(false);

    const outcomes = await sup.shutdown();
    expect(outcomes).toHaveLength(2);
    expect(sup.live.size).toBe(0);
    expect(sup.allTreesReclaimed()).toBe(true);
  });

  it("closeStdin() is the cooperative rung and ends the process", async () => {
    const sup = fakeSupervisor();
    const p = (await sup.spawn(spec())) as FakeAgentProcess;
    p.closeStdin();
    expect(await p.exited).toMatchObject({ requested: true, code: 0 });
    expect(sup.live.size).toBe(0);
  });
});
