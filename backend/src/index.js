export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Handle CORS preflight requests
    if (request.method === 'OPTIONS') {
      return handleCorsPreflight();
    }

    try {
      // Routing
      if (url.pathname === '/api/generate-title' && request.method === 'POST') {
        const body = await request.json();
        return await handleGenerateTitle(body, env.GEMINI_API_KEY);
      }

      if (url.pathname === '/api/chat' && request.method === 'POST') {
        const body = await request.json();
        // Pass env for logging context if needed, remove if unused
        return await handleChat(body, env.GEMINI_API_KEY, env);
      }

      // Not Found
      return withCorsHeaders({ error: 'Not found' }, 404);

    } catch (err) {
      // Log the error for debugging on the worker side
      console.error(`Caught error processing ${request.method} ${request.url}:`, err.stack || err);
      return withCorsHeaders({ error: err.message || 'Internal server error' }, 500);
    }
  }
}

// Consistent CORS Headers Function
function addCorsHeaders(headers = {}) {
  return {
    ...headers,
    'Access-Control-Allow-Origin': '*', // Or restrict to your frontend's origin in production
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization', // Add Authorization if you use it
  };
}

// Handle CORS Preflight explicitly
function handleCorsPreflight() {
  return new Response(null, {
    status: 204, // No Content
    headers: addCorsHeaders()
  });
}

// Wrapper to add CORS headers to actual responses
function withCorsHeaders(body, status = 200, contentType = 'application/json') {
  const headers = addCorsHeaders();
  if (status !== 204 && contentType) {
    headers['Content-Type'] = contentType;
  }

  return new Response(
    body && status !== 204 ? (typeof body === 'string' ? body : JSON.stringify(body)) : null,
    {
      status,
      headers,
    }
  );
}


// Handle title generation (seems okay, minor cleanup)
async function handleGenerateTitle(body, apiKey) {
  // Default model defined here for clarity
  const { prompt, model = "gemini-1.5-flash-latest" } = body; // Use latest alias

  if (!prompt) {
      console.error('Generate Title: Missing prompt');
      return withCorsHeaders({ error: 'Missing prompt' }, 400);
  }

  // Simplified title prompt
  const title_prompt = `Generate a concise chat title (under 5 words) for this user prompt: ${prompt}`;
  console.log('Generate Title: Sending prompt:', title_prompt);

  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: title_prompt }] }],
        // Optional: Add safety settings or generation config if needed
      }),
    });

    const result = await response.json();

    if (!response.ok) {
        console.error('Generate Title Error from API:', response.status, JSON.stringify(result));
        const errorMessage = result?.error?.message || 'API error during title generation';
        return withCorsHeaders({ error: errorMessage }, response.status);
    }

    const title = result.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    console.log('Generate Title: Received title:', title);

    if (!title) {
        console.error('Generate Title: Failed to extract title from API response:', JSON.stringify(result));
        return withCorsHeaders({ error: 'Failed to generate title from API response' }, 500);
    }

    // Remove potential quotes or markdown formatting from title
    const cleanedTitle = title.replace(/^["']|["']$/g, '').replace(/[*_`]/g, '');

    return withCorsHeaders({ title: cleanedTitle });

  } catch (error) {
      console.error('Generate Title: Network or fetch error:', error);
      return withCorsHeaders({ error: 'Failed to reach title generation API' }, 500);
  }
}


// --- REVISED Handle chat interaction ---
async function handleChat(body, apiKey, env) {
  const { prompt, history = [], model, imageData } = body;

  console.log(`Chat Request: Model=${model}, HasPrompt=${!!prompt}, HasImageData=${!!imageData}, HistoryLength=${history.length}`);

  if (!model || (!prompt && !imageData)) {
    console.error('Chat Error: Missing model or input (prompt/imageData)');
    return withCorsHeaders({ error: 'Missing model, prompt, or image data' }, 400);
  }

  const contents = [];
  history.forEach(item => {
      if (item.role && item.parts && Array.isArray(item.parts) && item.parts.length > 0) {
          contents.push(item);
      } else {
          console.warn('Chat Warning: Skipping invalid history item:', item);
      }
  });

  const userParts = [];
  if (prompt) {
      userParts.push({ text: prompt });
  }
  if (imageData && imageData.mimeType && imageData.base64) {
      if (!model.includes('vision') && !model.includes('1.5')) {
           console.warn(`Chat Warning: Sending image data to non-vision model (${model}). This might fail.`);
      }
      userParts.push({
          inline_data: {
              mime_type: imageData.mimeType,
              data: imageData.base64,
          },
      });
  } else if (imageData) {
      console.warn('Chat Warning: imageData provided but mimeType or base64 missing.');
  }

  if (userParts.length > 0) {
      contents.push({ role: "user", parts: userParts });
  } else {
      console.error('Chat Error: No valid user input (prompt or image) found.');
      return withCorsHeaders({ error: 'No user input provided' }, 400);
  }

  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?key=${apiKey}&alt=sse`;
  console.log(`Chat Request: Calling API: ${apiUrl}`);

  try {
    const apiResponse = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream'
      },
      body: JSON.stringify({ contents }),
    });

    if (!apiResponse.ok) {
      const errorBody = await apiResponse.text();
      console.error(`Chat Error: Gemini API returned ${apiResponse.status}: ${errorBody}`);
      let errorMessage = 'Chat API error';
      try {
        const errJson = JSON.parse(errorBody);
        errorMessage = errJson.error?.message || errorBody;
      } catch (e) { /* Ignore */ }
      return withCorsHeaders({ error: errorMessage }, apiResponse.status);
    }

    console.log('Chat Request: API call successful, processing stream...');

    // --- Improved SSE Transformer with Buffering ---
    let buffer = ''; // Buffer for incomplete lines
    let accumulatedTextForLog = "";
    const sseTransformer = new TransformStream({
      transform(chunk, controller) {
        const textDecoder = new TextDecoder();
        // Prepend buffer and decode the current chunk
        buffer += textDecoder.decode(chunk);

        // Process lines separated by double newlines (standard SSE separator)
        // Or just single newlines if that's how Gemini sends them consistently
        let boundary = buffer.indexOf('\n\n'); // Look for standard SSE message boundary first
        if (boundary === -1) {
            // Fallback: Check if messages might be just separated by single newline
            // Caution: This might be less robust if data payload itself contains single newlines
            // boundary = buffer.indexOf('\n');
            // If single newline is too risky, just let the buffer grow until '\n\n' appears
            // For now, stick to the standard '\n\n' or process line-by-line if single '\n' is certain
             boundary = buffer.lastIndexOf('\n'); // Process up to the last newline in the buffer for line-by-line
             if (boundary === -1 && buffer.length > 4096) { // Safety break if buffer grows too large without newline
                console.warn("SSE Buffer growing large without newline, flushing part.");
                boundary = buffer.length; // Process the whole buffer if stuck
             } else if (boundary === -1) {
                return; // Need more data if no newline found yet
             }
        }


        // Process all complete messages in the buffer
        // while (boundary !== -1) { // Use this loop if splitting by '\n\n'
        // const message = buffer.substring(0, boundary).trim();
        // buffer = buffer.substring(boundary + 2); // Consume message + boundary ('\n\n')
        let processable = buffer.substring(0, boundary);
        buffer = buffer.substring(boundary + 1); // Consume processed part + newline

        const lines = processable.split('\n');

        for (const line of lines) {
             if (line.startsWith('data:')) {
                const jsonData = line.substring(5).trim();
                if (jsonData) {
                   try {
                     const parsed = JSON.parse(jsonData);
                     const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
                     if (typeof text === 'string') {
                       accumulatedTextForLog += text;
                       controller.enqueue(new TextEncoder().encode(text));
                     }
                   } catch (e) {
                     // Log error BUT importantly, don't stop the stream.
                     // The buffer might contain the rest of the JSON in the next chunk.
                     // We only *know* it's an error if the full message boundary (\n\n) passed
                     // and parsing still failed. This basic line-by-line approach might still log errors
                     // for fragments, but hopefully recovers.
                     console.error('Chat Error (potential fragment): Failed to parse SSE JSON data:', jsonData, e);
                   }
                }
            }
            // Handle other SSE lines like 'event:', 'id:', 'retry:' if needed
        }
        // boundary = buffer.indexOf('\n\n'); // Find next boundary for the while loop
        // } // End of while loop (for '\n\n' splitting)

      },
      flush(controller) {
        // Process any remaining data in the buffer when the stream ends
        if (buffer.trim()) {
            console.log("Flushing remaining SSE buffer:", buffer);
             const lines = buffer.split('\n');
             for (const line of lines) {
                if (line.startsWith('data:')) {
                    const jsonData = line.substring(5).trim();
                    if (jsonData) {
                       try {
                         const parsed = JSON.parse(jsonData);
                         const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
                         if (typeof text === 'string') {
                           accumulatedTextForLog += text;
                           controller.enqueue(new TextEncoder().encode(text));
                         }
                       } catch (e) {
                         console.error('Chat Error (flush): Failed to parse SSE JSON data:', jsonData, e);
                       }
                    }
                }
            }
        }
        console.log("Chat Request: Gemini stream finished. Total text accumulated (for log):", accumulatedTextForLog.length, "chars");
        if (!accumulatedTextForLog.trim()) {
          console.warn("Chat Warning: Stream finished, but no text content was extracted.");
        }
      }
    });

    const processedStream = apiResponse.body.pipeThrough(sseTransformer);

    const responseHeaders = addCorsHeaders({
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache', // Ensure client doesn't cache partial stream
    });

    return new Response(processedStream, {
      status: 200,
      headers: responseHeaders,
    });

  } catch (error) {
    console.error('Chat Error: Network error or failure during fetch/stream processing:', error.stack || error);
    return withCorsHeaders({ error: 'Failed to communicate with chat API or process stream' }, 500);
  }
}
