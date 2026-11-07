export default {
  fetch() {
    return new Response("Hello World!", {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  },
} satisfies ExportedHandler;
