import io

p = 'src/activities/activity.service.ts'
s = io.open(p, encoding='utf-8').read()

NL = chr(10)
Q3 = chr(39) * 3

old2 = (
    "      if (!dedup) {" + NL +
    "        await this.timeline.record(tx, {" + NL +
    "          companyId," + NL +
    "          entityType: activity.relatedEntityType," + NL +
    "          entityId: activity.relatedEntityId," + NL +
    "          type: 'ACTIVITY_COMPLETED'," + NL +
    "          title: `" + chr(1578) + chr(1604) + chr(1605) + chr(1740) + chr(1604) + " " + chr(1601) + chr(1593) + chr(1575) + chr(1604) + chr(1740) + chr(1578) + ": ${activity.title}`," + NL +
    "          description: note ?? activity.description ?? undefined," + NL +
    "          data: { activityId: id, typeCode: activity.type.code }," + NL +
    "          actorUserId: actor.id," + NL +
    "        });" + NL +
    "      }" + NL +
    "    });" + NL +
    "    await this.audit.record({" + NL +
    "      entityType: 'activity'," + NL +
    "      entityId: id," + NL +
    "      action: 'COMPLETE'," + NL +
    "      companyId," + NL +
    "      actor," + NL +
    "      newValues: { completedAt: new Date().toISOString(), note: note ?? null }," + NL +
    "    });"
)
new2 = (
    "      if (!dedup) {" + NL +
    "        await this.timeline.record(tx, {" + NL +
    "          companyId," + NL +
    "          entityType: activity.relatedEntityType," + NL +
    "          entityId: activity.relatedEntityId," + NL +
    "          type: 'ACTIVITY_COMPLETED'," + NL +
    "          title: `" + chr(1578) + chr(1603) + chr(1605) + chr(1740) + chr(1604) + " " + chr(1601) + chr(1593) + chr(1575) + chr(1604) + chr(1740) + chr(1578) + ": ${activity.title}`," + NL +
    "          description: note ?? activity.description ?? undefined," + NL +
    "          data: { activityId: id, typeCode: activity.type.code }," + NL +
    "          actorUserId: actor.id," + NL +
    "        });" + NL +
    "      }" + NL +
    "      await this.audit.recordTx(tx, {" + NL +
    "        entityType: 'activity'," + NL +
    "        entityId: id," + NL +
    "        action: 'COMPLETE'," + NL +
    "        companyId," + NL +
    "        actor," + NL +
    "        newValues: { completedAt: new Date().toISOString(), note: note ?? null }," + NL +
    "      });" + NL +
    "    });"
)
c2 = s.count(old2)
print('complete block found:', c2)
if c2 == 1:
    s = s.replace(old2, new2)

old3 = (
    "    await this.prisma.activity.update({ where: { id }, data: { status: 'CANCELLED' } });" + NL +
    "    await this.audit.record({" + NL +
    "      entityType: 'activity'," + NL +
    "      entityId: id," + NL +
    "      action: 'CANCEL'," + NL +
    "      companyId," + NL +
    "      actor," + NL +
    "      reason," + NL +
    "    });"
)
new3 = (
    "    await this.prisma.$transaction(async (tx) => {" + NL +
    "      await tx.activity.update({ where: { id }, data: { status: 'CANCELLED' } });" + NL +
    "      await this.audit.recordTx(tx, {" + NL +
    "        entityType: 'activity'," + NL +
    "        entityId: id," + NL +
    "        action: 'CANCEL'," + NL +
    "        companyId," + NL +
    "        actor," + NL +
    "        reason," + NL +
    "      });" + NL +
    "    });"
)
c3 = s.count(old3)
print('cancel block found:', c3)
if c3 == 1:
    s = s.replace(old3, new3)

old4 = (
    "    await this.prisma.activity.delete({ where: { id } });" + NL +
    "    await this.audit.record({" + NL +
    "      entityType: 'activity'," + NL +
    "      entityId: id," + NL +
    "      action: 'DELETE'," + NL +
    "      companyId," + NL +
    "      actor," + NL +
    "      oldValues: { title: activity.title, status: activity.status }," + NL +
    "    });"
)
new4 = (
    "    // completed activities carry authority-facing history - they are never" + NL +
    "    // hard-deleted; use the audited manager override to amend instead" + NL +
    "    if (activity.status === 'COMPLETED') {" + NL +
    "      throw new ConflictError('ACTIVITY_COMPLETED_NOT_DELETABLE', { status: activity.status });" + NL +
    "    }" + NL +
    "    await this.prisma.$transaction(async (tx) => {" + NL +
    "      await tx.activity.delete({ where: { id } });" + NL +
    "      await this.audit.recordTx(tx, {" + NL +
    "        entityType: 'activity'," + NL +
    "        entityId: id," + NL +
    "        action: 'DELETE'," + NL +
    "        companyId," + NL +
    "        actor," + NL +
    "        oldValues: { title: activity.title, status: activity.status }," + NL +
    "      });" + NL +
    "    });"
)
c4 = s.count(old4)
print('delete block found:', c4)
if c4 == 1:
    s = s.replace(old4, new4)

old5 = (
    "    const type = await this.prisma.activityType.create({" + NL +
    "      data: { companyId, code: input.code.trim(), nameFa: input.nameFa.trim(), color: input.color ?? null }," + NL +
    "    });" + NL +
    "    await this.audit.record({" + NL +
    "      entityType: 'activity_type'," + NL +
    "      entityId: type.id," + NL +
    "      action: 'CREATE'," + NL +
    "      companyId," + NL +
    "      actor," + NL +
    "      newValues: { code: type.code, nameFa: type.nameFa }," + NL +
    "    });" + NL +
    "    return type;"
)
new5 = (
    "    let created!: { id: string; code: string; nameFa: string; color: string | null; active: boolean };" + NL +
    "    await this.prisma.$transaction(async (tx) => {" + NL +
    "      created = await tx.activityType.create({" + NL +
    "        data: { companyId, code: input.code.trim(), nameFa: input.nameFa.trim(), color: input.color ?? null }," + NL +
    "      });" + NL +
    "      await this.audit.recordTx(tx, {" + NL +
    "        entityType: 'activity_type'," + NL +
    "        entityId: created.id," + NL +
    "        action: 'CREATE'," + NL +
    "        companyId," + NL +
    "        actor," + NL +
    "        newValues: { code: created.code, nameFa: created.nameFa }," + NL +
    "      });" + NL +
    "    });" + NL +
    "    return created;"
)
c5 = s.count(old5)
print('createType block found:', c5)
if c5 == 1:
    s = s.replace(old5, new5)

io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('done', c2, c3, c4, c5)
