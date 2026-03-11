import React, { useState, useEffect, useRef } from 'react';
import SockJS from 'sockjs-client';
import { Client } from '@stomp/stompjs';
const BACKEND_URL = 'https://chat-app-backend-178i.onrender.com';

export default function Chat({ username, token, onLogout }) {
  const [messages, setMessages] = useState([]);
  const [privateMessages, setPrivateMessages] = useState([]);
  const [input, setInput] = useState('');
  const [connected, setConnected] = useState(false);
  const [users, setUsers] = useState([]);
  const [selectedUser, setSelectedUser] = useState(null);
  const [typingUsers, setTypingUsers] = useState({});
  const clientRef = useRef(null);
  const bottomRef = useRef(null);
  const typingTimeoutRef = useRef(null);
  const selectedUserRef = useRef(null); // ref to track selectedUser inside WebSocket

  // Keep ref in sync with state
  useEffect(() => {
    selectedUserRef.current = selectedUser;
  }, [selectedUser]);

  // Fetch user list
  useEffect(() => {
    fetch(`${BACKEND_URL}/api/users`, {
      headers: { Authorization: `Bearer ${token}` }
    })
      .then(res => res.json())
      .then(data => setUsers(data.filter(u => u !== username)))
      .catch(err => console.error('Failed to fetch users', err));
  }, [token, username]);

  // Load public chat history on mount
  useEffect(() => {
    fetch(`${BACKEND_URL}/api/history`, {
      headers: { Authorization: `Bearer ${token}` }
    })
      .then(res => res.json())
      .then(data => setMessages(data))
      .catch(err => console.error('Failed to fetch history', err));
  }, [token]);

  // Load private conversation history when selecting a user
  useEffect(() => {
    if (!selectedUser) return;
    fetch(`${BACKEND_URL}/api/conversation?user1=${username}&user2=${selectedUser}`, {
      headers: { Authorization: `Bearer ${token}` }
    })
      .then(res => res.json())
      .then(data => setPrivateMessages(data))
      .catch(err => console.error('Failed to fetch conversation', err));
  }, [selectedUser, username, token]);

  // Connect WebSocket
  useEffect(() => {
    const socket = new SockJS(`${BACKEND_URL}/ws?username=${username}`);
    const client = new Client({
      webSocketFactory: () => socket,
      onConnect: () => {
        setConnected(true);

        client.publish({
          destination: '/app/chat.addUser',
          body: JSON.stringify({ sender: username, type: 'JOIN' }),
        });

        // Subscribe to public chat
        client.subscribe('/topic/public', (msg) => {
          const body = JSON.parse(msg.body);

          if (body.type === 'TYPING') {
            setTypingUsers(prev => ({ ...prev, [body.sender]: body.typing }));
            return;
          }

          // Only add to public messages if it's not a private message
          if (!body.receiver) {
            setMessages(prev => {
              const isDuplicate = prev.some(
                m => m.sender === body.sender && m.content === body.content && m.timestamp === body.timestamp
              );
              return isDuplicate ? prev : [...prev, body];
            });
          }
        });

        // Subscribe to private messages
        client.subscribe('/user/queue/private', (msg) => {
          const body = JSON.parse(msg.body);

          if (body.type === 'TYPING') {
            setTypingUsers(prev => ({ ...prev, [body.sender]: body.typing }));
            setTimeout(() => {
              setTypingUsers(prev => ({ ...prev, [body.sender]: false }));
            }, 3000);
            return;
          }

          if (body.type === 'READ') {
            setPrivateMessages(prev =>
              prev.map(m =>
                m.sender === username && m.receiver === body.sender
                  ? { ...m, read: true }
                  : m
              )
            );
            return;
          }

          setPrivateMessages(prev => [...prev, body]);

          // Send read receipt if we are currently viewing this conversation
          if (body.sender === selectedUserRef.current) {
            client.publish({
              destination: '/app/chat.read',
              body: JSON.stringify({
                sender: username,
                receiver: body.sender,
                type: 'READ',
              }),
            });
          }
        });
      },
      onDisconnect: () => setConnected(false),
      onStompError: (frame) => console.error('STOMP error', frame),
    });

    client.activate();
    clientRef.current = client;

    return () => client.deactivate();
  }, [username]);

  // Send read receipt when opening a private chat
  useEffect(() => {
    if (!selectedUser || !connected || !clientRef.current) return;
    clientRef.current.publish({
      destination: '/app/chat.read',
      body: JSON.stringify({
        sender: username,
        receiver: selectedUser,
        type: 'READ',
      }),
    });
  }, [selectedUser, connected, username]);

  // Auto scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, privateMessages, selectedUser]);

  const handleTyping = (e) => {
    setInput(e.target.value);
    if (!connected || !clientRef.current) return;

    clientRef.current.publish({
      destination: '/app/chat.typing',
      body: JSON.stringify({
        sender: username,
        receiver: selectedUserRef.current || null,
        type: 'TYPING',
        typing: true,
      }),
    });

    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      clientRef.current.publish({
        destination: '/app/chat.typing',
        body: JSON.stringify({
          sender: username,
          receiver: selectedUserRef.current || null,
          type: 'TYPING',
          typing: false,
        }),
      });
    }, 2000);
  };

  const sendMessage = () => {
    if (!input.trim() || !connected) return;

    if (selectedUser) {
      clientRef.current.publish({
        destination: '/app/chat.sendPrivateMessage',
        body: JSON.stringify({
          sender: username,
          receiver: selectedUser,
          content: input,
          type: 'CHAT',
        }),
      });
    } else {
      clientRef.current.publish({
        destination: '/app/chat.sendMessage',
        body: JSON.stringify({
          sender: username,
          content: input,
          type: 'CHAT',
        }),
      });
    }

    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    clientRef.current.publish({
      destination: '/app/chat.typing',
      body: JSON.stringify({
        sender: username,
        receiver: selectedUserRef.current || null,
        type: 'TYPING',
        typing: false,
      }),
    });

    setInput('');
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') sendMessage();
  };

  const displayMessages = selectedUser
    ? privateMessages.filter(
        m => (m.sender === username && m.receiver === selectedUser) ||
             (m.sender === selectedUser && m.receiver === username)
      )
    : messages;

  const currentlyTyping = selectedUser
    ? typingUsers[selectedUser]
    : Object.entries(typingUsers)
        .filter(([user, isTyping]) => isTyping && user !== username)
        .map(([user]) => user);

  const typingText = selectedUser
    ? currentlyTyping ? `${selectedUser} is typing...` : null
    : currentlyTyping.length > 0
      ? `${currentlyTyping.join(', ')} ${currentlyTyping.length === 1 ? 'is' : 'are'} typing...`
      : null;

  return (
    <div style={styles.container}>
      <div style={styles.sidebar}>
        <div style={styles.sidebarHeader}>💬 Chats</div>
        <div
          style={{ ...styles.userItem, background: selectedUser === null ? '#e6f7ff' : 'transparent' }}
          onClick={() => setSelectedUser(null)}
        >
          🌐 Public Chat
        </div>
        <div style={styles.sidebarLabel}>Users</div>
        {users.length === 0 && <div style={styles.noUsers}>No other users yet</div>}
        {users.map(user => (
          <div
            key={user}
            style={{ ...styles.userItem, background: selectedUser === user ? '#e6f7ff' : 'transparent' }}
            onClick={() => setSelectedUser(user)}
          >
            👤 {user}
          </div>
        ))}
      </div>

      <div style={styles.main}>
        <div style={styles.header}>
          <span>
            {selectedUser ? `💬 Private: ${selectedUser}` : '🌐 Public Chat'} — <strong>{username}</strong>
          </span>
          <span style={styles.status}>{connected ? '🟢 Connected' : '🔴 Disconnected'}</span>
          <button style={styles.logoutBtn} onClick={onLogout}>Logout</button>
        </div>

        <div style={styles.messages}>
          {displayMessages.map((msg, i) => {
            const isMe = msg.sender === username;
            const isSystem = msg.type === 'JOIN' || msg.type === 'LEAVE';
            if (isSystem) {
              return (
                <div key={i} style={styles.systemMsg}>
                  {msg.sender} {msg.type === 'JOIN' ? 'joined the chat' : 'left the chat'}
                </div>
              );
            }
            return (
              <div key={i} style={{ ...styles.message, alignSelf: isMe ? 'flex-end' : 'flex-start' }}>
                <span style={styles.sender}>{isMe ? 'You' : msg.sender}</span>
                <div style={{
                  ...styles.bubble,
                  background: isMe ? '#1890ff' : '#f0f0f0',
                  color: isMe ? '#fff' : '#000',
                }}>
                  {msg.content}
                </div>
                <div style={styles.msgMeta}>
                  {msg.timestamp && <span style={styles.time}>{msg.timestamp}</span>}
                  {isMe && selectedUser && (
                    <span style={{ fontSize: '11px', color: msg.read ? '#1890ff' : '#bbb', marginLeft: '4px' }}>
                      {msg.read ? '✓✓' : '✓'}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>

        {typingText && (
          <div style={styles.typingIndicator}>
            <span style={styles.typingDots}>●●●</span> {typingText}
          </div>
        )}

        <div style={styles.inputRow}>
          <input
            style={styles.input}
            value={input}
            onChange={handleTyping}
            onKeyDown={handleKeyDown}
            placeholder={selectedUser ? `Message ${selectedUser}...` : 'Message everyone...'}
          />
          <button style={styles.sendBtn} onClick={sendMessage} disabled={!connected}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

const styles = {
  container: { display: 'flex', height: '100vh', fontFamily: 'sans-serif' },
  sidebar: { width: '220px', background: '#fff', borderRight: '1px solid #eee', display: 'flex', flexDirection: 'column' },
  sidebarHeader: { padding: '16px', fontWeight: 'bold', fontSize: '16px', borderBottom: '1px solid #eee' },
  sidebarLabel: { padding: '8px 16px', fontSize: '11px', color: '#999', textTransform: 'uppercase' },
  userItem: { padding: '10px 16px', cursor: 'pointer', fontSize: '14px', borderRadius: '4px', margin: '2px 8px' },
  noUsers: { padding: '8px 16px', fontSize: '13px', color: '#bbb' },
  main: { flex: 1, display: 'flex', flexDirection: 'column' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 20px', background: '#1890ff', color: '#fff' },
  status: { fontSize: '13px' },
  logoutBtn: { background: 'transparent', border: '1px solid #fff', color: '#fff', padding: '4px 12px', borderRadius: '4px', cursor: 'pointer' },
  messages: { flex: 1, overflowY: 'auto', padding: '20px', display: 'flex', flexDirection: 'column', gap: '12px', background: '#f5f5f5' },
  message: { display: 'flex', flexDirection: 'column', maxWidth: '60%' },
  sender: { fontSize: '11px', color: '#888', marginBottom: '2px' },
  bubble: { padding: '8px 14px', borderRadius: '18px', fontSize: '14px', wordBreak: 'break-word' },
  msgMeta: { display: 'flex', alignItems: 'center', marginTop: '2px' },
  time: { fontSize: '10px', color: '#bbb' },
  systemMsg: { textAlign: 'center', fontSize: '12px', color: '#999', padding: '4px' },
  typingIndicator: { padding: '6px 20px', fontSize: '12px', color: '#999', background: '#f5f5f5' },
  typingDots: { color: '#1890ff', marginRight: '4px' },
  inputRow: { display: 'flex', padding: '12px', gap: '8px', background: '#fff', borderTop: '1px solid #eee' },
  input: { flex: 1, padding: '10px', borderRadius: '4px', border: '1px solid #ccc', fontSize: '14px' },
  sendBtn: { padding: '10px 20px', background: '#1890ff', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' },
};
