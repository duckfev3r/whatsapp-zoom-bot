import { describe, expect, it } from "vitest";
import { ZoomClient, ZoomHttpError } from "../src/zoom/client.js";
import { encodeMeetingUuid } from "../src/zoom/uuid.js";

describe("encodeMeetingUuid", () => {
  it("encodes ordinary UUIDs once", () => {
    expect(encodeMeetingUuid("4444AAAiAAAAAiAiAiiAii==")).toBe("4444AAAiAAAAAiAiAiiAii%3D%3D");
    expect(encodeMeetingUuid("ab+cd/ef==")).toBe("ab%2Bcd%2Fef%3D%3D");
  });

  it("double-encodes UUIDs that start with /", () => {
    expect(encodeMeetingUuid("/ajXp112QmuoKj4854875==")).toBe(
      "%252FajXp112QmuoKj4854875%253D%253D",
    );
  });

  it("double-encodes UUIDs that contain //", () => {
    expect(encodeMeetingUuid("abc//def==")).toBe("abc%252F%252Fdef%253D%253D");
  });
});

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function fakeFetch(routes: (c: Call) => Response) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body as string | undefined,
    };
    calls.push(call);
    if (call.url.startsWith("https://zoom.us/oauth/token")) {
      return Response.json({ access_token: "tok", expires_in: 3600 });
    }
    return routes(call);
  }) as typeof fetch;
  return { fn, calls };
}

function client(routes: (c: Call) => Response) {
  const f = fakeFetch(routes);
  const c = new ZoomClient({
    accountId: "acc",
    clientId: "cid",
    clientSecret: "csecret",
    hostUser: "host@example.com",
    fetch: f.fn,
  });
  return { c, calls: f.calls };
}

describe("ZoomClient", () => {
  it("gets an S2S OAuth token once and reuses it", async () => {
    const { c, calls } = client(() => Response.json({ status: "started", uuid: "u1" }));
    await c.meetingStatus("1");
    await c.meetingStatus("1");
    const tokenCalls = calls.filter((x) => x.url.includes("oauth/token"));
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]?.url).toContain("grant_type=account_credentials");
    expect(tokenCalls[0]?.url).toContain("account_id=acc");
    expect(tokenCalls[0]?.headers.Authorization).toBe(
      `Basic ${Buffer.from("cid:csecret").toString("base64")}`,
    );
  });

  it("creates meetings with the spec's settings", async () => {
    const { c, calls } = client(() =>
      Response.json({ id: 85012345678, join_url: "https://z/j/1" }),
    );
    const m = await c.createMeeting({ topic: "Sync", record: true, passcode: "Ab3dEf7h" });
    expect(m).toEqual({ id: "85012345678", joinUrl: "https://z/j/1" });
    const call = calls.at(-1) as Call;
    expect(call.method).toBe("POST");
    expect(call.url).toBe("https://api.zoom.us/v2/users/host%40example.com/meetings");
    expect(JSON.parse(call.body as string)).toEqual({
      topic: "Sync",
      type: 1,
      password: "Ab3dEf7h",
      settings: {
        join_before_host: true,
        jbh_time: 0,
        waiting_room: false,
        auto_recording: "cloud",
        mute_upon_entry: true,
        meeting_authentication: false,
      },
    });
  });

  it("turns recording off for norecord", async () => {
    const { c, calls } = client(() => Response.json({ id: 1, join_url: "u" }));
    await c.createMeeting({ topic: "x", record: false, passcode: "abcdef" });
    expect(JSON.parse(calls.at(-1)?.body as string).settings.auto_recording).toBe("none");
  });

  it("double-encodes awkward UUIDs on the recordings API", async () => {
    const { c, calls } = client(() =>
      Response.json({
        recording_files: [{ file_type: "TRANSCRIPT", status: "completed", download_url: "d" }],
      }),
    );
    const files = await c.listRecordings("/abc//d==");
    expect(calls.at(-1)?.url).toBe(
      "https://api.zoom.us/v2/meetings/%252Fabc%252F%252Fd%253D%253D/recordings",
    );
    expect(files).toEqual([{ fileType: "TRANSCRIPT", status: "completed", downloadUrl: "d" }]);
  });

  it("returns null when an instance has no recordings", async () => {
    const { c } = client(() => new Response("{}", { status: 404 }));
    expect(await c.listRecordings("abc")).toBeNull();
  });

  it("maps meeting status, and 404 to gone", async () => {
    expect(
      await client(() => Response.json({ status: "waiting" })).c.meetingStatus("1"),
    ).toMatchObject({ status: "waiting" });
    expect(
      await client(() => Response.json({ status: "started", uuid: "u" })).c.meetingStatus("1"),
    ).toEqual({ status: "started", uuid: "u", startTime: undefined });
    expect(await client(() => new Response("", { status: 404 })).c.meetingStatus("1")).toEqual({
      status: "gone",
    });
  });

  it("ends meetings with PUT status", async () => {
    const { c, calls } = client(() => new Response(null, { status: 204 }));
    await c.endMeeting("123");
    expect(calls.at(-1)).toMatchObject({
      method: "PUT",
      url: "https://api.zoom.us/v2/meetings/123/status",
      body: JSON.stringify({ action: "end" }),
    });
  });

  it("rotates the host key with PATCH /users/{userId}", async () => {
    const { c, calls } = client(() => new Response(null, { status: 204 }));
    await c.setHostKey("123456");
    expect(calls.at(-1)).toMatchObject({
      method: "PATCH",
      url: "https://api.zoom.us/v2/users/host%40example.com",
      body: JSON.stringify({ host_key: "123456" }),
    });
  });

  it("throws ZoomHttpError when the host key update is refused", async () => {
    const { c } = client(
      () => new Response('{"code":4711,"message":"Invalid access token"}', { status: 400 }),
    );
    await expect(c.setHostKey("123456")).rejects.toBeInstanceOf(ZoomHttpError);
  });

  it("deletes recordings with the chosen action", async () => {
    const { c, calls } = client(() => new Response(null, { status: 204 }));
    await c.deleteRecordings("a/b", "delete");
    expect(calls.at(-1)).toMatchObject({
      method: "DELETE",
      url: "https://api.zoom.us/v2/meetings/a%2Fb/recordings?action=delete",
    });
  });

  it("downloads with the webhook download token when given", async () => {
    const { c, calls } = client(() => new Response("WEBVTT"));
    expect(await c.downloadText("https://zoom.us/rec/x", "dl")).toBe("WEBVTT");
    expect(calls.at(-1)?.headers.Authorization).toBe("Bearer dl");
  });
});
