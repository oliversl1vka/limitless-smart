import { expect } from 'chai';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { retryStrongerCommand, retryStranger } from './smart-router';

describe('smart-router', () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    sandbox.stub(process.env, 'AGENT_MODE').value(true);
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('should call retryStranger when AGENT_MODE is true', async () => {
    const mockRetryStranger = sandbox.stub(retryStranger, 'execute');
    await retryStrongerCommand();
    expect(mockRetryStranger.calledOnce).to.be.true;
  });

  it('should set AGENT_MODE to false before calling retryStranger', async () => {
    const mockSetEnv = sandbox.stub(process.env, 'AGENT_MODE', false);
    await retryStrongerCommand();
    expect(mockSetEnv.calledOnce).to.be.true;
  });

  it('should call retryStranger when AGENT_MODE is true and then reset it', async () => {
    const mockRetryStranger = sandbox.stub(retryStranger, 'execute');
    await retryStrongerCommand();
    expect(mockRetryStranger.calledOnce).to.be.true;
    expect(process.env.AGENT_MODE).to.equal('true');
  });

  it('should handle AGENT_MODE as a non-boolean value', async () => {
    process.env.AGENT_MODE = 'string';
    const mockRetryStranger = sandbox.stub(retryStranger, 'execute');
    await retryStrongerCommand();
    expect(mockRetryStranger.calledOnce).to.be.true;
  });

  it('should handle AGENT_MODE as false', async () => {
    process.env.AGENT_MODE = 'false';
    const mockRetryStranger = sandbox.stub(retryStranger, 'execute');
    await retryStrongerCommand();
    expect(mockRetryStranger.calledOnce).to.be.true;
  });

  it('should handle AGENT_MODE as an undefined value', async () => {
    delete process.env.AGENT_MODE;
    const mockRetryStranger = sandbox.stub(retryStranger, 'execute');
    await retryStrongerCommand();
    expect(mockRetryStranger.calledOnce).to.be.true;
  });

  it('should handle AGENT_MODE as a null value', async () => {
    process.env.AGENT_MODE = null;
    const mockRetryStranger = sandbox.stub(retryStranger, 'execute');
    await retryStrongerCommand();
    expect(mockRetryStranger.calledOnce).to.be.true;
  });

});
