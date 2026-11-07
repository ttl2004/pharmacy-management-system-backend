import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** Giới hạn khớp với RAG service (base-rag/api.py) để lỗi bị chặn ở BE, không đi tới RAG mới báo. */
export class AssistantChatTurn {
  @IsIn(['user', 'assistant'])
  @ApiProperty({ enum: ['user', 'assistant'] })
  role: 'user' | 'assistant';

  @IsString()
  @MaxLength(8000)
  @ApiProperty()
  content: string;
}

export class AssistantChatRequest {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  @ApiProperty({ example: 'Metformin chống chỉ định với những trường hợp nào?' })
  question: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => AssistantChatTurn)
  @ApiPropertyOptional({ type: [AssistantChatTurn], description: 'Các lượt hỏi/đáp trước, cũ → mới.' })
  history?: AssistantChatTurn[];

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(15)
  @ApiPropertyOptional({ description: 'Số đoạn truy xuất; bỏ trống = mặc định của RAG service.' })
  topK?: number;
}

export class AssistantFeedbackRequest {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @ApiProperty()
  answerId: string;

  @IsIn(['up', 'down'])
  @ApiProperty({ enum: ['up', 'down'] })
  rating: 'up' | 'down';

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  @ApiPropertyOptional()
  comment?: string;
}
