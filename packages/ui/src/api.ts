/** Admin-token plumbing: the console is private — every /meridian/* call
 *  carries the Bearer token; the gate screen collects it once per browser. */

const KEY = "meridian.adminToken";

export const adminToken = (): string => localStorage.getItem(KEY) ?? "";
export const setAdminToken = (t: string): void => localStorage.setItem(KEY, t);
export const clearAdminToken = (): void => localStorage.removeItem(KEY);

export function authed(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: { ...((init.headers as Record<string, string>) ?? {}), authorization: `Bearer ${adminToken()}` },
  });
}
