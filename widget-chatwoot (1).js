(function (d) {
  var currentScript =
    d.currentScript ||
    (function () {
      var scripts = d.getElementsByTagName("script");
      return scripts[scripts.length - 1];
    })();

  var INBOX_IDENTIFIER = currentScript.getAttribute("data-inbox-id");
  var LAUNCHER_COLOR = currentScript.getAttribute("data-color") || "#1D9E75";

  if (!INBOX_IDENTIFIER) {
    console.error("[ChatWidget] لم يتم تحديد data-inbox-id في وسم السكربت.");
    return;
  }

  var BASE = "https://app.chatwoot.com/public/api/v1";
  var WS_URL = "wss://app.chatwoot.com/cable";

  var sourceId, conversationId, pubsubToken;
  var ws,
    reconnectAttempts = 0,
    isManuallyClosed = false,
    lastMessageId = 0,
    started = false;

  var style = d.createElement("style");
  style.textContent = `
    #cw-launcher{position:fixed;bottom:20px;left:20px;width:56px;height:56px;border-radius:50%;background:${LAUNCHER_COLOR};color:#fff;border:none;font-size:24px;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.2);z-index:999999}
    #cw-panel{position:fixed;bottom:88px;left:20px;width:340px;max-width:90vw;height:480px;max-height:70vh;background:#fff;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.2);display:none;flex-direction:column;overflow:hidden;z-index:999999;direction:rtl;font-family:sans-serif}
    #cw-panel.open{display:flex}
    #cw-header{background:${LAUNCHER_COLOR};color:#fff;padding:14px 16px;font-size:15px;display:flex;justify-content:space-between;align-items:center}
    #cw-close{background:none;border:none;color:#fff;font-size:18px;cursor:pointer}
    #cw-messages{flex:1;overflow-y:auto;padding:12px;background:#fafafa}
    #cw-status{font-size:11px;color:#999;text-align:center;padding:4px 0;background:#f0f0f0}
    #cw-inputRow{display:flex;gap:8px;padding:10px;border-top:1px solid #eee}
    #cw-input{flex:1;padding:10px;border:1px solid #ccc;border-radius:8px;font-size:14px}
    #cw-send{padding:10px 16px;background:${LAUNCHER_COLOR};color:#fff;border:none;border-radius:8px;cursor:pointer}
  `;
  d.head.appendChild(style);

  var wrapper = d.createElement("div");
  wrapper.innerHTML = `
    <button id="cw-launcher">💬</button>
    <div id="cw-panel">
      <div id="cw-header">
        <span>الدعم الفني</span>
        <button id="cw-close">✕</button>
      </div>
      <div id="cw-messages"></div>
      <div id="cw-status">غير متصل</div>
      <div id="cw-inputRow">
        <input id="cw-input" type="text" placeholder="اكتب رسالتك هنا..." />
        <button id="cw-send">إرسال</button>
      </div>
    </div>
  `;
  d.body.appendChild(wrapper);

  var $launcher = d.getElementById("cw-launcher");
  var $panel = d.getElementById("cw-panel");
  var $messages = d.getElementById("cw-messages");
  var $status = d.getElementById("cw-status");
  var $input = d.getElementById("cw-input");

  function addMessage(content, isBot) {
    var div = d.createElement("div");
    div.style.cssText =
      "margin-bottom:10px;display:flex;justify-content:" +
      (isBot ? "flex-start" : "flex-end");
    var bubble = d.createElement("div");
    bubble.style.cssText =
      "max-width:75%;padding:10px 14px;border-radius:14px;font-size:14px;line-height:1.6;white-space:pre-wrap;background:" +
      (isBot ? "#E1F5EE" : "#EEEDFE") +
      ";color:" +
      (isBot ? "#04342C" : "#26215C");
    bubble.textContent = content;
    div.appendChild(bubble);
    $messages.appendChild(div);
    $messages.scrollTop = $messages.scrollHeight;
  }

  function setStatus(text) {
    $status.textContent = text;
  }

  $launcher.addEventListener("click", function () {
    $panel.classList.add("open");
    if (!started) {
      started = true;
      startConversation();
    }
  });
  d.getElementById("cw-close").addEventListener("click", function () {
    $panel.classList.remove("open");
  });

  function startConversation() {
    setStatus("جاري الاتصال...");
    fetch(BASE + "/inboxes/" + INBOX_IDENTIFIER + "/contacts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: "visitor-" + Date.now(),
        name: "زائر الموقع",
      }),
    })
      .then(function (res) {
        if (!res.ok) throw new Error("فشل إنشاء الزائر: " + res.status);
        return res.json();
      })
      .then(function (contactData) {
        sourceId = contactData.source_id;
        pubsubToken = contactData.pubsub_token;

        return fetch(
          BASE + "/inboxes/" + INBOX_IDENTIFIER + "/contacts/" + sourceId + "/conversations",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          }
        );
      })
      .then(function (res) {
        if (!res.ok) throw new Error("فشل إنشاء المحادثة: " + res.status);
        return res.json();
      })
      .then(function (convData) {
        conversationId = convData.id;
        connectRoomChannel();
      })
      .catch(function (err) {
        setStatus("❌ " + err.message);
      });
  }

  function sendMessage() {
    var content = $input.value.trim();
    if (!content || !conversationId) return;
    $input.value = "";
    addMessage(content, false);

    fetch(
      BASE +
        "/inboxes/" +
        INBOX_IDENTIFIER +
        "/contacts/" +
        sourceId +
        "/conversations/" +
        conversationId +
        "/messages",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: content, echo_id: "msg-" + Date.now() }),
      }
    ).catch(function () {
      addMessage("⚠️ فشل الإرسال", true);
    });
  }

  d.getElementById("cw-send").addEventListener("click", sendMessage);
  $input.addEventListener("keypress", function (e) {
    if (e.key === "Enter") sendMessage();
  });

  function reconcileMessages() {
    fetch(
      BASE +
        "/inboxes/" +
        INBOX_IDENTIFIER +
        "/contacts/" +
        sourceId +
        "/conversations/" +
        conversationId +
        "/messages"
    )
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .then(function (data) {
        if (!data) return;
        var list = Array.isArray(data) ? data : data.payload || [];
        list.forEach(function (m) {
          if (m.id > lastMessageId) {
            lastMessageId = m.id;
            if (m.message_type === 1) addMessage(m.content, true);
          }
        });
      })
      .catch(function (err) {
        console.error("reconcile error", err);
      });
  }

  function connectRoomChannel() {
    isManuallyClosed = false;
    ws = new WebSocket(WS_URL);

    ws.onopen = function () {
      setStatus("🔄 يتصل...");
    };

    ws.onmessage = function (event) {
      var data = JSON.parse(event.data);

      if (data.type === "welcome") {
        ws.send(
          JSON.stringify({
            command: "subscribe",
            identifier: JSON.stringify({
              channel: "RoomChannel",
              pubsub_token: pubsubToken,
            }),
          })
        );
        return;
      }

      if (data.type === "confirm_subscription") {
        reconnectAttempts = 0;
        setStatus("🟢 متصل");
        reconcileMessages();
        return;
      }

      if (data.type === "reject_subscription") {
        setStatus("❌ رفض الاشتراك");
        return;
      }

      if (data.type === "ping") return;

      var raw = data.message;
      if (!raw) return;
      var eventName = raw.event;
      var payload = raw.data || raw;

      if (eventName === "message.created" || eventName === "message.updated") {
        if (payload.id && payload.id > lastMessageId) lastMessageId = payload.id;
        if (payload.message_type === 1) addMessage(payload.content, true);
      }
    };

    ws.onerror = function () {
      setStatus("❌ خطأ اتصال");
    };

    ws.onclose = function () {
      if (isManuallyClosed) return;
      setStatus("🟡 إعادة اتصال...");
      reconnectAttempts++;
      var delay = Math.min(30, Math.pow(2, Math.min(reconnectAttempts, 5))) * 1000;
      setTimeout(connectRoomChannel, delay);
    };
  }
})(document);
