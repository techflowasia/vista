import { expect, test } from '../fixtures/base';
import { seedServerDocument, setCurrentScene, uniqueStageId } from '../fixtures/server-seed';
import { createSettingsStorage } from '../fixtures/test-data/settings';
import { DEFAULT_MODEL_SETTINGS } from '../fixtures/test-data/model-settings';

const USER_TEXT = 'Remember this chat after a page reload.';
const ASSISTANT_TEXT = 'History restored.';
const FOLLOW_UP_USER_TEXT = 'And keep this follow-up too.';
const FOLLOW_UP_ASSISTANT_TEXT = 'Follow-up saved.';

test('classroom chat history persists through the runtime store and reloads in the UI', async ({
  page,
  mockApi,
}) => {
  await mockApi.mockModelSettings(DEFAULT_MODEL_SETTINGS);
  await page.addInitScript(
    (settings) => {
      localStorage.setItem('maic:account:settings-storage', settings);
      localStorage.setItem('locale', 'en-US');
    },
    createSettingsStorage({ autoPlayLecture: false, ttsMuted: true, chatAreaCollapsed: false }),
  );

  await page.goto('/classroom/chat-storage-seed');
  const stageId = uniqueStageId('chat-storage-e2e');
  const sceneId = 'chat-storage-scene';
  const now = Date.now();
  await seedServerDocument(page, {
    stage: { id: stageId, name: 'Chat storage persistence', createdAt: now, updatedAt: now },
    scenes: [
      {
        id: sceneId,
        stageId,
        type: 'slide',
        title: 'Chat storage persistence',
        order: 0,
        content: { type: 'slide', canvas: { elements: [], background: { color: '#ffffff' } } },
        actions: [],
        createdAt: now,
        updatedAt: now,
      },
    ],
    outline: { outlines: [], generationComplete: true, createdAt: now, updatedAt: now },
  });
  await setCurrentScene(page, stageId, sceneId);

  let chatTurn = 0;
  await page.route('**/api/chat/pi', async (route) => {
    const turn = chatTurn++;
    const messageId = turn === 0 ? 'chat-storage-answer' : 'chat-storage-follow-up-answer';
    const assistantText = turn === 0 ? ASSISTANT_TEXT : FOLLOW_UP_ASSISTANT_TEXT;
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body: [
        {
          type: 'agent_start',
          data: { messageId, agentId: 'default-1', agentName: 'Teacher' },
        },
        { type: 'text_delta', data: { messageId, content: assistantText } },
        { type: 'agent_end', data: { messageId, agentId: 'default-1' } },
        {
          type: 'cue_user',
          data: { fromAgentId: 'default-1', prompt: 'What else would you like to know?' },
        },
        {
          type: 'done',
          data: {
            totalActions: 0,
            totalAgents: 1,
            agentHadContent: true,
            cueUserReceived: true,
            directorState: { turnCount: turn + 1, agentResponses: [], whiteboardLedger: [] },
          },
        },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(''),
    });
  });

  await page.goto(`/classroom/${stageId}`);
  await expect(page.getByTestId('scene-title').first()).toBeAttached({ timeout: 45_000 });
  await page.keyboard.press('T');
  const composer = page.getByPlaceholder('Type your message...', { exact: true });
  await expect(composer).toBeVisible();
  await composer.fill(USER_TEXT);
  const chatResponse = page.waitForResponse('**/api/chat/pi');
  await composer.press('Enter');
  await chatResponse;
  await expect(
    page.getByTestId('roundtable-non-presentation-card').getByText(ASSISTANT_TEXT, { exact: true }),
  ).toBeAttached({ timeout: 30_000 });

  await page.getByText('Chat', { exact: true }).first().click();
  const sessionHeader = page.getByRole('button', { name: /Q&A/ }).first();
  await expect(sessionHeader).toBeVisible();
  await sessionHeader.click();
  const chatPanel = page.getByLabel('Chat', { exact: true });
  await expect(chatPanel.getByText(USER_TEXT, { exact: true })).toBeVisible();
  await expect(chatPanel).toContainText(ASSISTANT_TEXT, { timeout: 30_000 });

  const learnerResponse = await page.evaluate(async () => {
    const response = await fetch('/api/persistence/learner-key', { credentials: 'same-origin' });
    return { status: response.status, body: (await response.json()) as { learnerKey: string } };
  });
  expect(learnerResponse.status).toBe(200);
  const { learnerKey } = learnerResponse.body;
  const sessionsUrl = `/api/persistence/runtime/stages/${encodeURIComponent(stageId)}/learners/${encodeURIComponent(learnerKey)}/sessions`;
  await expect
    .poll(async () => {
      const result = await page.evaluate(async (url) => {
        const response = await fetch(url, { credentials: 'same-origin' });
        return response.ok
          ? ((await response.json()) as Array<{ id: string; kind: string }>)
          : null;
      }, sessionsUrl);
      return result;
    })
    .toContainEqual(expect.objectContaining({ kind: 'chat' }));
  const sessionsResponse = await page.evaluate(async (url) => {
    const response = await fetch(url, { credentials: 'same-origin' });
    return {
      status: response.status,
      sessions: (await response.json()) as Array<{ id: string; kind: string }>,
    };
  }, sessionsUrl);
  expect(sessionsResponse.status).toBe(200);
  const runtimeSessions = sessionsResponse.sessions;
  const chatSession = runtimeSessions.find((session) => session.kind === 'chat');
  expect(chatSession).toBeDefined();
  let chatSessionId = chatSession!.id;
  const readChatMessages = async (sessionId: string) =>
    page.evaluate(async (runtimeId) => {
      const response = await fetch(
        `/api/persistence/runtime/sessions/${encodeURIComponent(runtimeId)}/records`,
        { credentials: 'same-origin' },
      );
      const records = response.ok
        ? ((await response.json()) as Array<{
            payload: { kind?: string; content?: string };
          }>)
        : [];
      return {
        status: response.status,
        messages: records
          .filter((record) => record.payload.kind === 'chat_message')
          .map((record) => record.payload.content ?? ''),
      };
    }, sessionId);

  await expect
    .poll(async () => (await readChatMessages(chatSessionId)).messages)
    .toContain(ASSISTANT_TEXT);
  const recordsResponse = await readChatMessages(chatSessionId);
  expect(recordsResponse.status).toBe(200);
  expect(recordsResponse.messages).toContain(USER_TEXT);
  expect(recordsResponse.messages).toContain(ASSISTANT_TEXT);

  await page.reload();
  await expect(page.getByTestId('scene-title').first()).toBeAttached({ timeout: 45_000 });
  await page.getByText('Chat', { exact: true }).first().click();
  const restoredHeader = page.getByRole('button', { name: /Q&A/ }).first();
  await expect(restoredHeader).toBeVisible();
  await restoredHeader.click();
  const restoredChatPanel = page.getByLabel('Chat', { exact: true });
  await expect(restoredChatPanel.getByText(USER_TEXT, { exact: true })).toBeVisible();
  await expect(restoredChatPanel).toContainText(ASSISTANT_TEXT, { timeout: 30_000 });

  await page.keyboard.press('T');
  const followUpComposer = page.getByPlaceholder('Type your message...', { exact: true });
  await expect(followUpComposer).toBeVisible();
  await followUpComposer.fill(FOLLOW_UP_USER_TEXT);
  const followUpResponse = page.waitForResponse('**/api/chat/pi');
  await followUpComposer.press('Enter');
  await followUpResponse;
  const latestChatSessions = await page.evaluate(async (url) => {
    const response = await fetch(url, { credentials: 'same-origin' });
    return (await response.json()) as Array<{ id: string; kind: string }>;
  }, sessionsUrl);
  chatSessionId = latestChatSessions.find((session) => session.kind === 'chat')!.id;
  await expect(restoredChatPanel.getByText(FOLLOW_UP_USER_TEXT, { exact: true })).toBeVisible();
  await expect(restoredChatPanel).toContainText(FOLLOW_UP_ASSISTANT_TEXT, { timeout: 30_000 });

  await expect
    .poll(async () => (await readChatMessages(chatSessionId)).messages)
    .toEqual(
      expect.arrayContaining([
        USER_TEXT,
        ASSISTANT_TEXT,
        FOLLOW_UP_USER_TEXT,
        FOLLOW_UP_ASSISTANT_TEXT,
      ]),
    );
});
