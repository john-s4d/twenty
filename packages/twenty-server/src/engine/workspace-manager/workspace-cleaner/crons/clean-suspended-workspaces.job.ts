import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import chunk from 'lodash.chunk';
import { WorkspaceActivationStatus } from 'twenty-shared';
import { Repository } from 'typeorm';

import { BillingSubscription } from 'src/engine/core-modules/billing/entities/billing-subscription.entity';
import { EnvironmentService } from 'src/engine/core-modules/environment/environment.service';
import { Process } from 'src/engine/core-modules/message-queue/decorators/process.decorator';
import { Processor } from 'src/engine/core-modules/message-queue/decorators/processor.decorator';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import { UserService } from 'src/engine/core-modules/user/services/user.service';
import { UserVarsService } from 'src/engine/core-modules/user/user-vars/services/user-vars.service';
import { WorkspaceService } from 'src/engine/core-modules/workspace/services/workspace.service';
import { Workspace } from 'src/engine/core-modules/workspace/workspace.entity';
import { USER_WORKSPACE_DELETION_WARNING_SENT_KEY } from 'src/engine/workspace-manager/workspace-cleaner/constants/user-workspace-deletion-warning-sent-key.constant';
import { WorkspaceMemberWorkspaceEntity } from 'src/modules/workspace-member/standard-objects/workspace-member.workspace-entity';

const MILLISECONDS_IN_ONE_DAY = 1000 * 3600 * 24;

@Processor(MessageQueue.cronQueue)
export class CleanSuspendedWorkspacesJob {
  private readonly logger = new Logger(CleanSuspendedWorkspacesJob.name);
  private readonly inactiveDaysBeforeDelete: number;
  private readonly inactiveDaysBeforeWarn: number;
  private readonly maxNumberOfWorkspacesDeletedPerExecution: number;

  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly environmentService: EnvironmentService,
    private readonly userService: UserService,
    private readonly userVarsService: UserVarsService,
    @InjectRepository(BillingSubscription, 'core')
    private readonly billingSubscriptionRepository: Repository<BillingSubscription>,
    @InjectRepository(Workspace, 'core')
    private readonly workspaceRepository: Repository<Workspace>,
  ) {
    this.inactiveDaysBeforeDelete = this.environmentService.get(
      'WORKSPACE_INACTIVE_DAYS_BEFORE_DELETION',
    );
    this.inactiveDaysBeforeWarn = this.environmentService.get(
      'WORKSPACE_INACTIVE_DAYS_BEFORE_NOTIFICATION',
    );
    this.maxNumberOfWorkspacesDeletedPerExecution = this.environmentService.get(
      'MAX_NUMBER_OF_WORKSPACES_DELETED_PER_EXECUTION',
    );
  }

  async computeWorkspaceBillingInactivity(
    workspace: Workspace,
  ): Promise<number | null> {
    try {
      const lastSubscription =
        await this.billingSubscriptionRepository.findOneOrFail({
          where: { workspaceId: workspace.id },
          order: { updatedAt: 'DESC' },
        });

      const daysSinceBillingInactivity = Math.floor(
        (new Date().getTime() - lastSubscription.updatedAt.getTime()) /
          MILLISECONDS_IN_ONE_DAY,
      );

      return daysSinceBillingInactivity;
    } catch {
      this.logger.error(
        `No billing subscription found for workspace ${workspace.id} ${workspace.displayName}`,
      );

      return null;
    }
  }

  async checkIfWorkspaceMembersWarned(
    workspaceMembers: WorkspaceMemberWorkspaceEntity[],
    workspaceId: string,
  ) {
    for (const workspaceMember of workspaceMembers) {
      const workspaceMemberWarned =
        (await this.userVarsService.get({
          userId: workspaceMember.userId,
          workspaceId: workspaceId,
          key: USER_WORKSPACE_DELETION_WARNING_SENT_KEY,
        })) === true;

      if (workspaceMemberWarned) {
        return true;
      }
    }

    return false;
  }

  async warnWorkspaceMembers(workspace: Workspace) {
    const workspaceMembers =
      await this.userService.loadWorkspaceMembers(workspace);

    const workspaceMembersWarned = await this.checkIfWorkspaceMembersWarned(
      workspaceMembers,
      workspace.id,
    );

    if (workspaceMembersWarned) {
      this.logger.log(
        `Workspace ${workspace.id} ${workspace.displayName} already warned`,
      );

      return;
    } else {
      const workspaceMembersChunks = chunk(workspaceMembers, 5);

      for (const workspaceMembersChunk of workspaceMembersChunks) {
        await Promise.all(
          workspaceMembersChunk.map(async (workspaceMember) => {
            await this.userVarsService.set({
              userId: workspaceMember.userId,
              workspaceId: workspace.id,
              key: USER_WORKSPACE_DELETION_WARNING_SENT_KEY,
              value: true,
            });
          }),
        );
      }

      // TODO: issue #284
      // send email warning for deletion in (this.inactiveDaysBeforeDelete - this.inactiveDaysBeforeWarn) days (cci @twenty.com)

      this.logger.log(
        `Warning Workspace ${workspace.id} ${workspace.displayName}`,
      );

      return;
    }
  }

  async informWorkspaceMembersAndDeleteWorkspace(workspace: Workspace) {
    const workspaceMembers =
      await this.userService.loadWorkspaceMembers(workspace);

    const workspaceMembersChunks = chunk(workspaceMembers, 5);

    for (const workspaceMembersChunk of workspaceMembersChunks) {
      await Promise.all(
        workspaceMembersChunk.map(async (workspaceMember) => {
          await this.userVarsService.delete({
            userId: workspaceMember.userId,
            workspaceId: workspace.id,
            key: USER_WORKSPACE_DELETION_WARNING_SENT_KEY,
          });
        }),

        // TODO: issue #285
        // send email informing about deletion (cci @twenty.com)
        // remove clean-inactive-workspace.job.ts and .. files
        // add new env var in infra
      );
    }

    await this.workspaceService.deleteWorkspace(workspace.id);
    this.logger.log(
      `Cleaning Workspace ${workspace.id} ${workspace.displayName}`,
    );
  }

  @Process(CleanSuspendedWorkspacesJob.name)
  async handle(): Promise<void> {
    this.logger.log(`Job running...`);

    const suspendedWorkspaces = await this.workspaceRepository.find({
      where: { activationStatus: WorkspaceActivationStatus.SUSPENDED },
    });

    const suspendedWorkspacesChunks = chunk(suspendedWorkspaces, 5);

    let deletedWorkspacesCount = 0;

    for (const suspendedWorkspacesChunk of suspendedWorkspacesChunks) {
      await Promise.all(
        suspendedWorkspacesChunk.map(async (workspace) => {
          const workspaceInactivity =
            await this.computeWorkspaceBillingInactivity(workspace);

          if (
            workspaceInactivity &&
            workspaceInactivity > this.inactiveDaysBeforeDelete &&
            deletedWorkspacesCount <=
              this.maxNumberOfWorkspacesDeletedPerExecution
          ) {
            await this.informWorkspaceMembersAndDeleteWorkspace(workspace);
            deletedWorkspacesCount++;

            return;
          }
          if (
            workspaceInactivity &&
            workspaceInactivity > this.inactiveDaysBeforeWarn &&
            workspaceInactivity <= this.inactiveDaysBeforeDelete
          ) {
            await this.warnWorkspaceMembers(workspace);

            return;
          }
        }),
      );
    }

    this.logger.log(`Job done!`);
  }
}
