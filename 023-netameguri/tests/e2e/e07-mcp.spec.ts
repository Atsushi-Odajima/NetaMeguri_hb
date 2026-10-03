import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { login, apiFor, DEMO } from './helpers';

const parse = (r: any) => JSON.parse(r.content[0].text);

// E2E-7: MCP「今日Threads」→ Unused Idea → Draft → checks → preview → handoff / publish (explicit confirmation)
test('E2E-7 MCP: today Threads → draft → checks → handoff → confirmed publish', async ({ page }) => {
  await login(page);
  const api = await apiFor(page);
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', 'server/src/mcp/stdio.ts'],
    env: { ...process.env, NETAMEGURI_DATA_DIR: './.e2e-data', NETAMEGURI_MCP_USER: DEMO.email, NETAMEGURI_MCP_WORKSPACE: api.wsId, NODE_NO_WARNINGS: '1' } as Record<string, string>,
  });
  const client = new Client({ name: 'e2e', version: '1.0.0' });
  await client.connect(transport);
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    for (const t of ['capture_source', 'create_content_pack', 'find_unused_ideas', 'check_idea_similarity', 'draft_for_platform', 'get_campaign', 'review_draft', 'get_recycling_candidates', 'search_content', 'get_performance_summary', 'prepare_publish', 'confirm_publish']) expect(tools).toContain(t);

    // 「今日Threadsに何か投稿したい」→ unused ideas (3案) → user picks #2
    const unused = parse(await client.callTool({ name: 'find_unused_ideas', arguments: { platform: 'threads', limit: 3 } }));
    expect(unused.ideas.length).toBeGreaterThanOrEqual(2);
    const pick = unused.ideas[1];
    const draft = parse(await client.callTool({ name: 'draft_for_platform', arguments: { ideaId: pick.ideaId, platform: 'threads' } }));
    expect(draft.contentId).toMatch(/^cnt_/);
    expect(draft.checks).toHaveProperty('brandGuard');
    expect(draft.checks).toHaveProperty('similar');
    const review = parse(await client.callTool({ name: 'review_draft', arguments: { contentId: draft.contentId } }));
    expect(review.content.platform).toBe('threads');

    // Not approved + MCP publish not allowed → handoff only, no confirmation code
    const prep1 = parse(await client.callTool({ name: 'prepare_publish', arguments: { contentId: draft.contentId } }));
    expect(prep1.autoPublishPossible).toBe(false);
    expect(prep1.confirmationCode).toBeNull();
    expect(prep1.handoff.text.length).toBeGreaterThan(10);
    const bad = await client.callTool({ name: 'confirm_publish', arguments: { contentId: draft.contentId, confirmationCode: 'guess', userApproved: true } });
    expect(bad.isError).toBe(true);

    // Human approves in the app and enables MCP publishing; then explicit confirmation publishes
    await api.post(`/content/${draft.contentId}/review`);
    await api.post(`/content/${draft.contentId}/approve`);
    await api.patch('/settings', { mcpPublishAllowed: true });
    const prep2 = parse(await client.callTool({ name: 'prepare_publish', arguments: { contentId: draft.contentId } }));
    expect(prep2.autoPublishPossible).toBe(true);
    expect(prep2.confirmationCode).toBeTruthy();
    const pub = parse(await client.callTool({ name: 'confirm_publish', arguments: { contentId: draft.contentId, confirmationCode: prep2.confirmationCode, userApproved: true } }));
    expect(pub.content.status).toBe('published');
    const c = await api.get(`/content/${draft.contentId}`);
    expect(c.content.publishedVia).toBe('api_confirmed');
  } finally {
    await api.patch('/settings', { mcpPublishAllowed: false });
    await client.close();
  }
});
