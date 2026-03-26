import {
  archiveNotionPage,
  createNotionAgendaPage,
  updateNotionPage,
  type NotionCommandEnv,
} from "../../notion.js";
import {
  hasExplicitNotionPageReference,
  loadThreadNotionPageTarget,
} from "../../thread-notion-page-target.js";
import { buildThreadPaths } from "../../thread-workspace.js";
import type { NotionManagedPageEntry } from "../../../state/manager-state-contract.js";
import type {
  ArchiveNotionPageProposal,
  CreateNotionAgendaProposal,
  ManagerCommandHandlerResult,
  ManagerCommittedCommand,
  UpdateNotionPageProposal,
} from "../contracts.js";
import type { CommitManagerCommandArgs } from "../contracts.js";
import { buildOccurredAt } from "../common.js";

function buildNotionEnv(config: CommitManagerCommandArgs["config"]): NotionCommandEnv {
  return {
    ...process.env,
    NOTION_API_TOKEN: config.notionApiToken,
  };
}

function resolveNotionUpdateMode(
  proposal: UpdateNotionPageProposal,
): "append" | "replace_section" {
  return proposal.mode ?? (proposal.appendMode ? "append" : "append");
}

function validateUpdateNotionPageProposal(
  proposal: UpdateNotionPageProposal,
): string | undefined {
  const mode = resolveNotionUpdateMode(proposal);
  if (mode === "append") {
    if (!proposal.title && !proposal.summary && (!proposal.sections || proposal.sections.length === 0)) {
      return "Notion page の更新内容が不足しています。title か追記内容を明示してください。";
    }
    return undefined;
  }

  if (!proposal.sectionHeading) {
    return "replace_section では sectionHeading が必要です。";
  }
  if (!proposal.paragraph && (!proposal.bullets || proposal.bullets.length === 0)) {
    return "Notion section の更新内容が不足しています。paragraph か bullets を明示してください。";
  }
  if (proposal.summary || (proposal.sections && proposal.sections.length > 0)) {
    return "replace_section では summary や sections は使えません。sectionHeading と paragraph/bullets を使ってください。";
  }
  return undefined;
}

function upsertManagedNotionPage(
  pages: NotionManagedPageEntry[],
  entry: NotionManagedPageEntry,
): NotionManagedPageEntry[] {
  const nextPages = pages.filter((page) => page.pageId !== entry.pageId);
  nextPages.push(entry);
  nextPages.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return nextPages;
}

async function resolveThreadScopedNotionPageId(
  args: CommitManagerCommandArgs,
  proposedPageId: string,
): Promise<string> {
  if (hasExplicitNotionPageReference(args.message.text)) {
    return proposedPageId;
  }

  const paths = buildThreadPaths(args.config.workspaceDir, args.message.channelId, args.message.rootThreadTs);
  const currentTarget = await loadThreadNotionPageTarget(paths).catch(() => undefined);
  if (!currentTarget?.pageId || currentTarget.pageId === proposedPageId) {
    return proposedPageId;
  }

  return currentTarget.pageId;
}

export async function commitCreateNotionAgendaProposal(
  args: CommitManagerCommandArgs,
  proposal: CreateNotionAgendaProposal,
): Promise<ManagerCommandHandlerResult> {
  if (!args.config.notionApiToken?.trim()) {
    return {
      proposal,
      reason: "Notion へのアジェンダ作成には NOTION_API_TOKEN の設定が必要です。",
    };
  }

  const parentPageId = proposal.parentPageId ?? args.config.notionAgendaParentPageId;
  if (!parentPageId?.trim()) {
    return {
      proposal,
      reason: "Notion へのアジェンダ作成先が未設定です。NOTION_AGENDA_PARENT_PAGE_ID を設定するか、親 page ID を明示してください。",
    };
  }

  const page = await createNotionAgendaPage(
    {
      title: proposal.title,
      parentPageId,
      summary: proposal.summary,
      sections: proposal.sections,
    },
    buildNotionEnv(args.config),
  );

  const managedPages = await args.repositories.notionPages.load();
  await args.repositories.notionPages.save(upsertManagedNotionPage(managedPages, {
    pageId: page.id,
    pageKind: "agenda",
    title: page.title ?? proposal.title,
    url: page.url ?? undefined,
    createdAt: buildOccurredAt(args.now),
    managedBy: "cogito",
  }));

  const linkedTitle = page.url
    ? `<${page.url}|${page.title ?? proposal.title}>`
    : (page.title ?? proposal.title);

  return {
    commandType: proposal.commandType,
    issueIds: [],
    summary: `Notion agenda created: ${linkedTitle}`,
    notionPageTargetEffect: {
      action: "set-active",
      pageId: page.id,
      title: page.title ?? proposal.title,
      url: page.url ?? undefined,
    },
  };
}

export async function commitUpdateNotionPageProposal(
  args: CommitManagerCommandArgs,
  proposal: UpdateNotionPageProposal,
): Promise<ManagerCommandHandlerResult> {
  const mode = resolveNotionUpdateMode(proposal);
  if (!args.config.notionApiToken?.trim()) {
    return {
      proposal,
      reason: "Notion page の更新には NOTION_API_TOKEN の設定が必要です。",
    };
  }
  const validationError = validateUpdateNotionPageProposal(proposal);
  if (validationError) {
    return {
      proposal,
      reason: validationError,
    };
  }

  const managedPages = await args.repositories.notionPages.load();
  const resolvedPageId = await resolveThreadScopedNotionPageId(args, proposal.pageId);
  if (mode === "replace_section" && !managedPages.some((page) => page.pageId === resolvedPageId)) {
    return {
      proposal,
      reason: "replace_section で更新できるのはコギト管理ページのみです。対象 page は notion-pages.json に登録されていません。",
    };
  }

  let page;
  try {
    page = await updateNotionPage(
      {
        pageId: resolvedPageId,
        mode,
        title: proposal.title,
        summary: proposal.summary,
        sections: proposal.sections,
        sectionHeading: proposal.sectionHeading,
        paragraph: proposal.paragraph,
        bullets: proposal.bullets,
      },
      buildNotionEnv(args.config),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes("archived")) {
      return {
        proposal,
        reason: "対象の Notion page は archive 済みです。この thread で最新の Notion page を使う場合は、そのページを明示するか同じ依頼をもう一度送ってください。",
      };
    }
    if (mode === "replace_section" && message.toLowerCase().includes("notion section")) {
      return {
        proposal,
        reason: message,
      };
    }
    throw error;
  }

  const existingManagedPage = managedPages.find((managedPage) => managedPage.pageId === page.id);
  if (existingManagedPage) {
    await args.repositories.notionPages.save(upsertManagedNotionPage(managedPages, {
      ...existingManagedPage,
      title: page.title ?? existingManagedPage.title,
      url: page.url ?? existingManagedPage.url,
    }));
  }

  const linkedTitle = page.url
    ? `<${page.url}|${page.title ?? proposal.title ?? proposal.pageId}>`
    : (page.title ?? proposal.title ?? proposal.pageId);

  return {
    commandType: proposal.commandType,
    issueIds: [],
    summary: mode === "replace_section"
      ? `Notion section updated: ${linkedTitle}`
      : `Notion page updated: ${linkedTitle}`,
    notionPageTargetEffect: {
      action: "set-active",
      pageId: page.id,
      title: page.title ?? proposal.title ?? proposal.pageId,
      url: page.url ?? undefined,
    },
  };
}

export async function commitArchiveNotionPageProposal(
  args: CommitManagerCommandArgs,
  proposal: ArchiveNotionPageProposal,
): Promise<ManagerCommandHandlerResult> {
  if (!args.config.notionApiToken?.trim()) {
    return {
      proposal,
      reason: "Notion page のアーカイブには NOTION_API_TOKEN の設定が必要です。",
    };
  }

  const resolvedPageId = await resolveThreadScopedNotionPageId(args, proposal.pageId);
  const page = await archiveNotionPage(
    resolvedPageId,
    buildNotionEnv(args.config),
  );

  const linkedTitle = page.url
    ? `<${page.url}|${page.title ?? proposal.pageId}>`
    : (page.title ?? proposal.pageId);

  return {
    commandType: proposal.commandType,
    issueIds: [],
    summary: `Notion page archived: ${linkedTitle}`,
    notionPageTargetEffect: {
      action: "clear",
      pageId: page.id,
      title: page.title ?? proposal.pageId,
      url: page.url ?? undefined,
    },
  };
}
