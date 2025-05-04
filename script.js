document.addEventListener('DOMContentLoaded', () => {
    const chatList = document.getElementById('chat-list');
    const messageList = document.getElementById('message-list');
    const chatForm = document.getElementById('chat-form');
    const promptInput = document.getElementById('prompt-input');
    const sendButton = document.getElementById('send-button');
    const newChatBtn = document.getElementById('new-chat-btn');
    const modelSelect = document.getElementById('model-select');
    const chatTitle = document.getElementById('chat-title');
    const sidebar = document.querySelector('.sidebar');
    const sidebarToggleBtn = document.getElementById('sidebar-toggle');
    const attachImageBtn = document.getElementById('attach-image-btn');
    const imageInput = document.getElementById('image-input');
    const imagePreviewContainer = document.getElementById('image-preview-container');
    const appContainer = document.querySelector('.app-container');
    let chats = {};
    let currentChatId = null;
    let currentModel = modelSelect.value;
    let currentStreamingMessageElement = null;
    let currentStreamingTextContainer = null;
    let attachedImage = null;
    let isGeneratingResponse = false;
    let sidebarOverlay = null;
    let accumulatedStreamedResponse = '';
    let lastRenderTime = 0;
    let renderThrottleTimeout = null;
    const RENDER_THROTTLE_INTERVAL = 150;
    let streamingChatId = null;
    const CHATS_STORAGE_KEY = 'gemini_chats';
    const CURRENT_CHAT_ID_STORAGE_KEY = 'gemini_current_chat_id';
    const BACKEND_URL = 'https://backend.karthiksambhu123.workers.dev';
    const md = window.markdownit({
        html: true,
        xhtmlOut: false,
        breaks: true,
        langPrefix: 'language-',
        linkify: true,
        typographer: true,
    });
    function init() {
        loadChats();
        createSidebarOverlay();
        setupEventListeners();
        renderChatList();
        if (!currentChatId && Object.keys(chats).length === 0) {
            createNewChat();
        } else if (!currentChatId && Object.keys(chats).length > 0) {
            currentChatId = Object.keys(chats).sort((a, b) => b - a)[0];
        }
        if (!chats[currentChatId] && Object.keys(chats).length > 0) {
             currentChatId = Object.keys(chats).sort((a, b) => b - a)[0];
        } else if (!chats[currentChatId]) {
             createNewChat();
             return;
        }
        switchChat(currentChatId);
        adjustTextareaHeight();
        updateSendButtonState();
    }
    function loadChats() {
        const storedChats = localStorage.getItem(CHATS_STORAGE_KEY);
        const storedCurrentChatId = localStorage.getItem(CURRENT_CHAT_ID_STORAGE_KEY);
        if (storedChats) {
            try {
                chats = JSON.parse(storedChats);
                if (typeof chats !== 'object' || chats === null) chats = {};
                Object.values(chats).forEach(chat => { if (!Array.isArray(chat.messages)) chat.messages = []; });
            } catch (e) {
                console.error("Failed to parse chats from localStorage:", e);
                chats = {};
            }
        } else {
            chats = {};
        }
        currentChatId = storedCurrentChatId || null;
        if (currentChatId && !chats[currentChatId]) {
            console.warn(`Stored currentChatId (${currentChatId}) not found in loaded chats. Selecting latest.`);
            currentChatId = Object.keys(chats).sort((a, b) => b - a)[0] || null;
        }
    }
    function saveChats() {
        try {
            localStorage.setItem(CHATS_STORAGE_KEY, JSON.stringify(chats));
            if (currentChatId) {
                localStorage.setItem(CURRENT_CHAT_ID_STORAGE_KEY, currentChatId);
            } else {
                localStorage.removeItem(CURRENT_CHAT_ID_STORAGE_KEY);
            }
        } catch (e) {
             console.error("Failed to save chats to localStorage:", e);
             appendMessage('error', 'Error: Could not save chat data. Storage might be full.');
        }
    }
    function createNewChat() {
        const newChatId = Date.now().toString();
        chats[newChatId] = {
            id: newChatId,
            title: 'New Chat',
            messages: []
        };
        currentChatId = newChatId;
        cancelThrottledRender();
        renderChatList();
        switchChat(newChatId);
        promptInput.focus();
        closeSidebar();
    }
    function switchChat(chatId) {
        if (!chatId || !chats[chatId]) {
            console.warn(`Attempted to switch to invalid chatId: ${chatId}. Falling back.`);
            const chatIds = Object.keys(chats).sort((a, b) => b - a);
            if (chatIds.length > 0) {
                chatId = chatIds[0];
            } else {
                if (currentChatId !== null) {
                    createNewChat();
                } else {
                     console.error("Cannot switch chat - no valid chats exist and creation failed.");
                     messageList.innerHTML = `<div class="message error"><div class="message-avatar">!</div><div class="message-content"><div class="text-content-inner"><p>Critical Error: Could not load or create chats.</p></div></div></div>`;
                     chatTitle.textContent = "Error";
                }
                return;
            }
        }
        if (streamingChatId && streamingChatId !== chatId && renderThrottleTimeout) {
            console.log("Switching chat during active stream, forcing final render for previous chat.");
            cancelThrottledRender();
            performRender(true);
        }
        currentChatId = chatId;
        cancelThrottledRender();
        renderMessages();
        chatTitle.textContent = chats[currentChatId]?.title || 'Chat';
        document.querySelectorAll('.chat-list-item').forEach(item => {
            item.classList.toggle('active', item.dataset.chatId === currentChatId);
        });
        saveChats();
        clearImagePreview();
        closeSidebar();
        promptInput.focus();
        updateSendButtonState();
    }
     function deleteChat(chatId) {
        if (!chats[chatId]) return;
        if (!confirm(`Are you sure you want to delete the chat "${chats[chatId].title || 'Untitled Chat'}"? This cannot be undone.`)) {
            return;
        }
        const deletedTitle = chats[chatId].title;
        delete chats[chatId];
        console.log(`Deleted chat: ${deletedTitle} (ID: ${chatId})`);
        if (chatId === streamingChatId) {
            cancelThrottledRender();
            streamingChatId = null;
            currentStreamingMessageElement = null;
            currentStreamingTextContainer = null;
            accumulatedStreamedResponse = '';
        }
        saveChats();
        renderChatList();
        if (currentChatId === chatId) {
            const remainingChatIds = Object.keys(chats).sort((a, b) => b - a);
            if (remainingChatIds.length > 0) {
                switchChat(remainingChatIds[0]);
            } else {
                createNewChat();
            }
        }
    }
    function renderChatList() {
        chatList.innerHTML = '';
        const sortedChatIds = Object.keys(chats).sort((a, b) => parseInt(b, 10) - parseInt(a, 10));
        if (sortedChatIds.length === 0) {
            chatList.innerHTML = '<li class="no-chats">No chats yet</li>';
            return;
        }
        sortedChatIds.forEach(chatId => {
            const chat = chats[chatId];
            if (!chat) return;
            const listItem = document.createElement('li');
            listItem.classList.add('chat-list-item');
            listItem.dataset.chatId = chatId;
            if (chatId === currentChatId) {
                listItem.classList.add('active');
            }
            const titleSpan = document.createElement('span');
            titleSpan.classList.add('chat-title-text');
            titleSpan.textContent = chat.title || 'Untitled Chat';
            const deleteBtn = document.createElement('button');
            deleteBtn.classList.add('delete-chat-btn');
            deleteBtn.innerHTML = '<i class="fas fa-trash-alt"></i>';
            deleteBtn.title = 'Delete Chat';
            deleteBtn.onclick = (e) => {
                e.stopPropagation();
                deleteChat(chatId);
            };
            listItem.appendChild(titleSpan);
            listItem.appendChild(deleteBtn);
            listItem.addEventListener('click', () => switchChat(chatId));
            chatList.appendChild(listItem);
        });
    }
    function renderMessages() {
        messageList.innerHTML = '';
        if (!currentChatId || !chats[currentChatId]) {
             messageList.innerHTML = `
                 <div class="message welcome-message">
                    <div class="message-avatar"><i class="fas fa-wand-magic-sparkles"></i></div>
                    <div class="message-content">
                        <div class="text-content-inner">
                            <p>Welcome! ✨ Select a chat or start a <a href="#" id="welcome-new-chat">new one</a>.</p>
                        </div>
                    </div>
                 </div>`;
             const newChatLink = document.getElementById('welcome-new-chat');
             if (newChatLink) {
                 newChatLink.onclick = (e) => { e.preventDefault(); createNewChat(); };
             }
             chatTitle.textContent = 'Gemini Aurora';
             return;
         }
        const currentMessages = Array.isArray(chats[currentChatId].messages) ? chats[currentChatId].messages : [];
        if (currentMessages.length === 0) {
             messageList.innerHTML = `
                 <div class="message welcome-message">
                     <div class="message-avatar"><i class="fas fa-feather-alt"></i></div>
                    <div class="message-content">
                         <div class="text-content-inner">
                             <p>This chat is empty. Send your first message!</p>
                             <p>${getAttachmentHint()}</p>
                         </div>
                    </div>
                 </div>`;
        } else {
            currentMessages.forEach(msg => {
                 if (msg && typeof msg.role === 'string' && typeof msg.content === 'string') {
                    appendMessage(msg.role, msg.content, false, msg.imagePreviewUrl);
                 } else {
                     console.warn("Skipping rendering invalid message object:", msg);
                 }
            });
            setTimeout(scrollToBottom, 50);
        }
    }
     function getAttachmentHint() {
         return `You can attach an image <i class="fas fa-paperclip"></i> with your message.`;
     }
    function appendMessage(role, content, isStreaming = false, imagePreviewUrl = null) {
        const validRoles = ['user', 'model', 'error'];
        const messageRole = validRoles.includes(role) ? role : 'model';
        const messageWrapper = document.createElement('div');
        messageWrapper.classList.add('message', messageRole);
        const avatar = document.createElement('div');
        avatar.classList.add('message-avatar');
        const avatarIcon = document.createElement('i');
        avatarIcon.className = `fas`;
        avatar.appendChild(avatarIcon);
        const contentElement = document.createElement('div');
        contentElement.classList.add('message-content');
        if (messageRole === 'user' && imagePreviewUrl) {
            try {
                const imgElement = document.createElement('img');
                imgElement.src = imagePreviewUrl;
                imgElement.alt = 'User upload preview';
                imgElement.onerror = () => { imgElement.style.display = 'none'; };
                contentElement.appendChild(imgElement);
            } catch (e) { console.error("Error creating image preview element:", e); }
        }
        const textContentDiv = document.createElement('div');
        textContentDiv.classList.add('text-content-inner');
        if (isStreaming && messageRole === 'model') {
            textContentDiv.textContent = 'Thinking...';
            messageWrapper.classList.add('loading');
            currentStreamingMessageElement = contentElement;
            currentStreamingTextContainer = textContentDiv;
            accumulatedStreamedResponse = '';
            streamingChatId = currentChatId;
            cancelThrottledRender();

        } else {
            try {
                if (messageRole === 'model' && typeof window.markdownit === 'function' && content?.trim()) {
                    textContentDiv.innerHTML = md.render(content);
                    textContentDiv.querySelectorAll('pre code').forEach((block) => {
                        highlightBlock(block);
                    });
                } else if (content?.trim()) {
                    const para = document.createElement('p');
                    para.textContent = content;
                    textContentDiv.appendChild(para);
                } else {
                    textContentDiv.innerHTML = '';
                }
            } catch (e) {
                console.error("Error rendering static message content:", e);
                textContentDiv.textContent = "[Error rendering content]";
            }
            if (streamingChatId === currentChatId) {
                currentStreamingMessageElement = null;
                currentStreamingTextContainer = null;
                streamingChatId = null;
                accumulatedStreamedResponse = '';
                cancelThrottledRender();
            }
        }
        contentElement.appendChild(textContentDiv);
        messageWrapper.appendChild(avatar);
        messageWrapper.appendChild(contentElement);
        messageList.appendChild(messageWrapper);
        if (!isStreaming || messageRole !== 'model') {
            scrollToBottom();
        }
        return contentElement;
    }
    function updateStreamingMessage(chunk) {
        if (!currentStreamingTextContainer || streamingChatId !== currentChatId) {
             if(streamingChatId && streamingChatId !== currentChatId) {
             } else if (!currentStreamingTextContainer) {
                 console.warn("Streaming update called without an active streaming text container.");
             }
            return;
        }
        accumulatedStreamedResponse += chunk;
        scheduleRender();
    }
    function scheduleRender() {
        const now = Date.now();
        if (!renderThrottleTimeout) {
            const delay = Math.max(0, RENDER_THROTTLE_INTERVAL - (now - lastRenderTime));
            renderThrottleTimeout = setTimeout(() => {
                performRender();
            }, delay);
        }
    }
    function performRender(isFinal = false) {
        if (!currentStreamingTextContainer || streamingChatId !== currentChatId) {
            console.warn("Render skipped: Target container gone or chat switched.");
            cancelThrottledRender();
            return;
        }
        try {
             if (currentStreamingTextContainer.textContent === 'Thinking...') {
                 currentStreamingTextContainer.innerHTML = '';
             }
            currentStreamingTextContainer.innerHTML = md.render(accumulatedStreamedResponse);
            lastRenderTime = Date.now();
            renderThrottleTimeout = null;
            scrollToBottom();
        } catch (e) {
            console.error("Error during throttled Markdown render:", e);
            currentStreamingTextContainer.textContent = "[Error rendering live preview]";
            cancelThrottledRender();
        }
        if(!isFinal) {
           renderThrottleTimeout = null;
        }
    }
    function cancelThrottledRender() {
        if (renderThrottleTimeout) {
            clearTimeout(renderThrottleTimeout);
            renderThrottleTimeout = null;
        }
    }
    function finalizeStreamingMessage(fullContent) {
        cancelThrottledRender();
        if (!currentStreamingMessageElement || !currentStreamingTextContainer || streamingChatId !== currentChatId) {
             console.warn(`Finalize called for wrong chat (${streamingChatId} vs ${currentChatId}) or elements missing. Skipping final UI update.`);
             accumulatedStreamedResponse = '';
             streamingChatId = null;
             lastRenderTime = 0;
             return;
        }
        const messageWrapper = currentStreamingMessageElement.parentElement;
        if (messageWrapper) {
            messageWrapper.classList.remove('loading');
        }
        try {
            currentStreamingTextContainer.innerHTML = md.render(fullContent || '');
            currentStreamingTextContainer.querySelectorAll('pre code').forEach((block) => {
                 highlightBlock(block);
            });
        } catch (e) {
            console.error("Error during final Markdown render/highlight:", e);
            currentStreamingTextContainer.textContent = fullContent || '[Error rendering final response]';
        } finally {
             currentStreamingMessageElement = null;
             currentStreamingTextContainer = null;
             accumulatedStreamedResponse = '';
             streamingChatId = null;
             lastRenderTime = 0;
             scrollToBottom();
        }
    }
    function highlightBlock(block) {
        if (typeof hljs !== 'undefined') {
             const languageClass = Array.from(block.classList).find(cls => cls.startsWith('language-'));
             const language = languageClass ? languageClass.replace('language-', '') : null;
            try {
                 if (language && hljs.getLanguage(language)) {
                     hljs.highlightElement(block);
                 } else {
                      hljs.highlightElement(block);
                 }
            } catch (__) {
                console.warn("Highlight.js error on block:", __, block.textContent.substring(0, 50) + "...");
                block.parentElement?.classList.add('code-block-error');
            }
        } else {
             block.parentElement?.classList.add('code-block-default');
        }
    }
    function scrollToBottom() {
        messageList.scrollTo({ top: messageList.scrollHeight, behavior: 'smooth' });
    }
    function adjustTextareaHeight() {
        promptInput.style.height = 'auto';
        const scrollHeight = promptInput.scrollHeight;
        promptInput.style.height = `${scrollHeight + 2}px`;
    }
    function shouldEnableImageInput() {
        return true;
    }
    function updateSendButtonState() {
        const text = promptInput.value.trim();
        const canAttachImage = shouldEnableImageInput();
        const hasAttachedImage = attachedImage !== null;
        let sendDisabled = true;
        let attachDisabled = true;
        let attachTitle = 'Attach Image';
        if (isGeneratingResponse) {
            sendDisabled = true;
            attachDisabled = true;
            attachTitle = 'Generating response...';
        } else {
            sendDisabled = !(text.length > 0 || hasAttachedImage);
            attachDisabled = !canAttachImage;
            attachTitle = canAttachImage ? 'Attach Image' : 'Image attachment not supported';
        }
        sendButton.disabled = sendDisabled;
        attachImageBtn.disabled = attachDisabled;
        attachImageBtn.title = attachTitle;
        attachImageBtn.style.cursor = attachDisabled ? 'not-allowed' : 'pointer';
        attachImageBtn.style.opacity = attachDisabled ? 0.5 : 1;
    }
    function showImagePreview(file) {
        if (!file) { clearImagePreview(); return; }
        const reader = new FileReader();
        reader.onload = function(e) {
            imagePreviewContainer.innerHTML = `
                <img src="${e.target.result}" alt="Image Preview">
                <button id="remove-image-btn" title="Remove Image">×</button>
            `;
            document.getElementById('remove-image-btn').addEventListener('click', clearImagePreview);
            const base64String = e.target.result.split(',')[1];
            attachedImage = { filename: file.name, base64: base64String, mimeType: file.type };
            imagePreviewContainer.classList.remove('hidden');
            updateSendButtonState();
        }
        reader.onerror = () => { appendMessage('error', 'Error reading image file.'); clearImagePreview(); };
        reader.readAsDataURL(file);
    }
    function clearImagePreview() {
        attachedImage = null;
        imageInput.value = '';
        imagePreviewContainer.classList.add('hidden');
        imagePreviewContainer.innerHTML = '';
        updateSendButtonState();
    }
    function createSidebarOverlay() {
        sidebarOverlay = document.createElement('div');
        sidebarOverlay.classList.add('sidebar-overlay');
        appContainer.appendChild(sidebarOverlay);
        sidebarOverlay.addEventListener('click', closeSidebar);
    }
    function openSidebar() {
        if (window.innerWidth <= 768) {
            sidebar.classList.add('open');
            sidebarOverlay.classList.add('active');
        }
    }
    function closeSidebar() {
        if (window.innerWidth <= 768) {
            sidebar.classList.remove('open');
            sidebarOverlay.classList.remove('active');
        }
    }
    async function sendMessage() {
        if (isGeneratingResponse) return;
        const promptText = promptInput.value.trim();
        if (!currentChatId || !chats[currentChatId]) { appendMessage('error', 'Error: No active chat selected.'); return; }
        if (!Array.isArray(chats[currentChatId].messages)) chats[currentChatId].messages = [];
        if (!promptText && !attachedImage) return;
        isGeneratingResponse = true;
        updateSendButtonState();
        let userMessageContent = promptText;
        let userImagePreview = null;
        let includeImageDataInRequest = false;
        if (attachedImage) {
            userImagePreview = `data:${attachedImage.mimeType};base64,${attachedImage.base64}`;
            if (!promptText) userMessageContent = `(Image attached: ${attachedImage.filename})`;
            includeImageDataInRequest = true;
        }
        const userMessage = { role: 'user', content: userMessageContent, imagePreviewUrl: userImagePreview };
        appendMessage(userMessage.role, userMessage.content, false, userMessage.imagePreviewUrl);
        chats[currentChatId].messages.push(userMessage);
        const historyForApi = chats[currentChatId].messages
            .slice(0, -1)
            .filter(msg => msg.role === 'user' || msg.role === 'model')
            .map(msg => ({
                role: msg.role,
                parts: [{ text: msg.content }]
            }));
        const requestBody = {
            model: currentModel,
            history: historyForApi,
            prompt: promptText,
        };
        if (includeImageDataInRequest && attachedImage) {
            requestBody.imageData = {
                mimeType: attachedImage.mimeType,
                base64: attachedImage.base64
            };
        }
        const currentRequestChatId = currentChatId;
        promptInput.value = '';
        adjustTextareaHeight();
        clearImagePreview();
        const isFirstTextMessage = chats[currentRequestChatId].messages.filter(m => m.role === 'user').length === 1 && promptText.length > 0;
        if (isFirstTextMessage && chats[currentRequestChatId].title === 'New Chat') {
            generateChatTitle(promptText, currentRequestChatId);
        }
        let aiMessagePlaceholder = { role: 'model', content: '' };
        chats[currentRequestChatId].messages.push(aiMessagePlaceholder);
        appendMessage('model', '', true);
        saveChats();
        let fullApiResponse = '';
        try {
            console.log(`Sending request for chat ${currentRequestChatId}, model ${currentModel}`);
            const response = await fetch(`${BACKEND_URL}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody),
            });
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ error: `HTTP error! Status: ${response.status}` }));
                throw new Error(errorData.error || `API request failed: ${response.statusText || response.status}`);
            }
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = decoder.decode(value, { stream: true });
                fullApiResponse += chunk;
                if (currentChatId === currentRequestChatId) {
                    updateStreamingMessage(chunk);
                }
            }
            aiMessagePlaceholder.content = fullApiResponse;
            if (currentChatId === currentRequestChatId) {
                finalizeStreamingMessage(fullApiResponse);
            } else {
                 console.log(`Stream finished for chat ${currentRequestChatId}, but user is viewing ${currentChatId}. Final UI update skipped, state saved.`);
                 if(streamingChatId === currentRequestChatId) {
                    cancelThrottledRender();
                    currentStreamingMessageElement = null;
                    currentStreamingTextContainer = null;
                    accumulatedStreamedResponse = '';
                    streamingChatId = null;
                    lastRenderTime = 0;
                 }
            }
            console.log(`Streaming processing finished for chat ${currentRequestChatId}`);
            saveChats();
        } catch (error) {
            console.error(`Error during API call for chat ${currentRequestChatId}:`, error);
            appendMessage('error', `Error generating response: ${error.message}`);
            scrollToBottom();
            if (chats[currentRequestChatId]) {
                const lastMessageIndex = chats[currentRequestChatId].messages.length - 1;
                if (lastMessageIndex >= 0 && chats[currentRequestChatId].messages[lastMessageIndex] === aiMessagePlaceholder) {
                    chats[currentRequestChatId].messages.pop();
                }
                saveChats();
            }
            if (currentChatId === currentRequestChatId) {
                 cancelThrottledRender();
                 if (currentStreamingMessageElement) {
                      const messageWrapper = currentStreamingMessageElement.parentElement;
                      if (messageWrapper && messageList.contains(messageWrapper)) {
                          messageList.removeChild(messageWrapper);
                      }
                 }
                 currentStreamingMessageElement = null;
                 currentStreamingTextContainer = null;
                 accumulatedStreamedResponse = '';
                 streamingChatId = null;
                 lastRenderTime = 0;
            }
        } finally {
            isGeneratingResponse = false;
            updateSendButtonState();
            if (currentChatId === currentRequestChatId) {
                 promptInput.focus();
            }
        }
    }
    async function generateChatTitle(firstPrompt, chatIdForTitle) {
        if (!chatIdForTitle || !chats[chatIdForTitle] || chats[chatIdForTitle].title !== 'New Chat') {
            console.log(`Skipping title generation for chat ${chatIdForTitle}`);
            return;
        }
        try {
            const response = await fetch(`${BACKEND_URL}/api/generate-title`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: firstPrompt }),
            });
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ error: 'Failed to parse title error' }));
                throw new Error(errorData.error || `Title generation failed: ${response.status}`);
            }
            const data = await response.json();
            if (data.title && chats[chatIdForTitle] && chats[chatIdForTitle].title === 'New Chat') {
                chats[chatIdForTitle].title = data.title;
                if (chatIdForTitle === currentChatId) chatTitle.textContent = data.title;
                saveChats();
                renderChatList();
            }
        } catch (error) { console.error(`Error generating chat title for ${chatIdForTitle}:`, error); }
    }
    function setupEventListeners() {
        chatForm.addEventListener('submit', (e) => { e.preventDefault(); sendMessage(); });
        promptInput.addEventListener('input', () => { adjustTextareaHeight(); updateSendButtonState(); });
        promptInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (!isGeneratingResponse) sendMessage();
            }
        });
        newChatBtn.addEventListener('click', createNewChat);
        modelSelect.addEventListener('change', (e) => { currentModel = e.target.value; updateSendButtonState(); });
        sidebarToggleBtn.addEventListener('click', (e) => { e.stopPropagation(); sidebar.classList.contains('open') ? closeSidebar() : openSidebar(); });
        attachImageBtn.addEventListener('click', () => { if (!attachImageBtn.disabled) imageInput.click(); });
        imageInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                if (!file.type.startsWith('image/')) { appendMessage('error', 'Please select an image file.'); clearImagePreview(); return; }
                const maxSizeMB = 5;
                if (file.size > maxSizeMB * 1024 * 1024) { appendMessage('error', `Image size exceeds ${maxSizeMB}MB.`); clearImagePreview(); return; }
                showImagePreview(file);
            } else { clearImagePreview(); }
        });
        window.addEventListener('resize', () => {
            if (window.innerWidth > 768) {
                closeSidebar();
                if(sidebarOverlay) sidebarOverlay.classList.remove('active');
                sidebar.classList.remove('open');
            }
        });
    }
    init();
});