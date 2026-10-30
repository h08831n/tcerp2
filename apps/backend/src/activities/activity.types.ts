import type { ActivityPriority, ActivityStatus } from '@prisma/client';

export interface ActivityActor {
  id: string;
  username: string;
}

export interface CreateActivityInput {
  typeCode: string;
  title: string;
  description?: string;
  relatedEntityType: string;
  relatedEntityId: string;
  assignedToId?: string;
  priority?: ActivityPriority;
  scheduledDate?: Date;
  dueDate?: Date;
  actorType?: 'USER' | 'SYSTEM';
  actor?: ActivityActor;
}

export interface UpdateActivityInput {
  title?: string;
  description?: string;
  assignedToId?: string | null;
  priority?: ActivityPriority;
  scheduledDate?: Date | null;
  dueDate?: Date | null;
}

export interface ActivityListFilters {
  assignedToId?: string;
  status?: ActivityStatus;
  priority?: ActivityPriority;
  typeCode?: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
  dueFrom?: Date;
  dueTo?: Date;
  overdueOnly?: boolean;
  page?: number;
  pageSize?: number;
}

export interface ActivityViewer {
  userId: string;
  scopeAll: boolean;
}
