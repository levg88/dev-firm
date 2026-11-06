import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/api/app';
import { delay, makeSettings, SAMPLE_BRIEF } from './helpers';

async function waitForWorkflow(
  agent: any,
  workflowId: number,
  timeoutMs = 20000,
): Promise<Record<string, any>> {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, any> = {};
  while (Date.now() < deadline) {
    const response = await agent.get(`/build/${workflowId}/status`);
    expect(response.status).toBe(200);
    last = response.body;
    if (last.status === 'done' || last.status === 'failed') return last;
    await delay(50);
  }
  throw new Error(`Workflow ${workflowId} did not finish: ${JSON.stringify(last)}`);
}

describe('web app', () => {
  it('renders pages and runs a mock build', async () => {
    const app = createApp(makeSettings());
    const agent = request(app);
    for (const path of ['/', '/build', '/runs', '/settings']) {
      const response = await agent.get(path);
      expect(response.status).toBe(200);
    }
    const health = await agent.get('/health');
    expect(health.body.ok).toBe(true);
    expect(health.body.provider).toBe('mock');

    const created = await agent.post('/build').send({ brief: SAMPLE_BRIEF, title: 'Reading list' });
    expect(created.status).toBe(303);
    expect(created.headers.location).toMatch(/^\/build\/\d+$/);
    const workflowId = Number(created.headers.location.split('/').pop());
    const status = await waitForWorkflow(agent, workflowId);
    expect(status.status).toBe('done');

    const detail = await agent.get(`/build/${workflowId}`);
    expect(detail.status).toBe(200);
    expect(detail.text).toContain('product_spec.md');
    expect(detail.text).toContain('qa_report.md');
    expect(detail.text).toContain('Tickets');

    const board = await agent.get('/tickets');
    expect(board.status).toBe(200);
    expect(board.text).toContain('Delivery board');
    const ticketKey = board.text.match(/CAREER-\d+/)?.[0];
    expect(ticketKey).toBeTruthy();

    const ticket = await agent.get(`/tickets/${ticketKey}`);
    expect(ticket.status).toBe(200);
    expect(ticket.text).toContain('History');
    expect(ticket.text).toContain(String(ticketKey));
  });

  it('rejects an empty brief', async () => {
    const app = createApp(makeSettings());
    const response = await request(app).post('/build').send({ brief: '   ' });
    expect(response.status).toBe(400);
    expect(response.text).toContain('Describe the app you want to build');
  });
});
