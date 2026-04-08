import type { AIChatRequest } from "../../dist/index.js";

const request: AIChatRequest = {
  messages: [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "hello"
        }
      ]
    }
  ]
};

console.log(request);
