globalThis.fetch = async (input) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const payload = url.pathname.endsWith("/activities") || url.pathname.endsWith("/wellness")
    ? []
    : { sportSettings: [] };
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
