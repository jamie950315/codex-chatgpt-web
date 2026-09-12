/** Gate test clients before forwarding anything to the installed mixed-routing server. */
export function allowWebOnlySmokeRequest(method: string, path: string, model: unknown): boolean {
  return method === "POST" && ["/v1/responses", "/v1/responses/compact"].includes(path)
    && model === "chatgpt-web/pro";
}
