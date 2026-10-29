import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { ErrorCode } from 'src/common/types/error-code';

/** Một thuốc như nguồn CSDL Dược trả về; ngày dạng `yyyy-mm-dd`, ô rỗng là `null`. Nguồn còn trả thêm cột tra cứu, BE bỏ qua. */
export interface DrugSourceRecord {
  code: string;
  name: string;
  drugGroup: string | null;
  controlType: string | null;
  isPrescription: boolean;
  registrationNumber: string | null;
  registeredAt: string | null;
  registrationExpiresAt: string | null;
  strength: string | null;
  ingredients: string | null;
  manufacturerName: string | null;
  countryOfOrigin: string | null;
  packagingSpec: string | null;
  route: string | null;
}

interface DrugSourcePage {
  items: DrugSourceRecord[];
  total: number;
}

const PAGE_SIZE = 100;
const REQUEST_TIMEOUT_MS = 10_000;

/** Đọc toàn bộ danh mục thuốc từ nguồn ngoài (hiện là API giả lập ở repo CSDL-Drug). */
@Injectable()
export class DrugSourceClient {
  private readonly baseUrl: string;

  constructor(config: ConfigService) {
    this.baseUrl = config.getOrThrow<string>('DRUG_SOURCE_URL');
  }

  async fetchAll(): Promise<DrugSourceRecord[]> {
    const drugs: DrugSourceRecord[] = [];
    for (let page = 1; ; page++) {
      const { items, total } = await this.fetchPage(page);
      drugs.push(...items);
      if (!items.length || drugs.length >= total) return drugs;
    }
  }

  private async fetchPage(page: number): Promise<DrugSourcePage> {
    const url = new URL('/api/v1/drugs', this.baseUrl);
    url.searchParams.set('page', String(page));
    url.searchParams.set('pageSize', String(PAGE_SIZE));

    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch {
      throw this.unavailable(`Không kết nối được nguồn CSDL Dược (${this.baseUrl})`);
    }
    if (!response.ok) throw this.unavailable(`Nguồn CSDL Dược trả lỗi HTTP ${response.status}`);

    const body = (await response.json()) as DrugSourcePage;
    if (!Array.isArray(body.items) || body.items.some((drug) => !drug.code || !drug.name)) {
      throw this.unavailable('Dữ liệu nguồn CSDL Dược sai định dạng (thiếu mã hoặc tên thuốc)');
    }
    return body;
  }

  private unavailable(message: string): ErrorException {
    return new ErrorException({ code: ErrorCode.DRUG_SOURCE_UNAVAILABLE, message });
  }
}
