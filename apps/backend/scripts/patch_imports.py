import io

p = 'src/activities/activity.service.ts'
s = io.open(p, encoding='utf-8').read()

# 1) clean the mangled import head
bad1 = "import { Injectable, NotFoundException } from '@nestjs/common';"
bad2 = "import { ConflictError, NotFoundError, NotFoundError, ValidationError } from '../common/errors';"
good_head = (
    "import { Injectable } from '@nestjs/common';" + chr(10) +
    "import { ConflictError, NotFoundError, ValidationError } from '../common/errors';"
)
s = s.replace(bad1, "__NESTJS__", 1)
s = s.replace(bad2, "__ERRORS__", 1)
s = s.replace("__NESTJS__", good_head.split(chr(10))[0], 1)
s = s.replace("__ERRORS__", good_head.split(chr(10))[1], 1)

# 2) the two remaining NotFoundException usages -> NotFoundError
s = s.replace("throw new NotFoundException('Activity not found', { id });",
              "throw new NotFoundError('Activity not found', { id });")

io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('head cleaned + usages fixed')
