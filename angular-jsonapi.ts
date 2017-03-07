import {
    Http,
    Response,
    HttpModule,
    Headers
} from "@angular/http";
import {
    Injectable,
    Inject,
    ReflectiveInjector,
    Provider,
    NgModule,
    Optional,
    SkipSelf,
    OpaqueToken,
    ModuleWithProviders
} from "@angular/core";
import { Observable } from 'rxjs/Observable';
import 'rxjs/add/operator/map';
import 'rxjs/add/operator/catch';
import 'rxjs/add/observable/throw';
import * as _ from 'lodash';

export function Attribute() {
    return function (target: any, propertyName: string) {

        let saveAnnotations = function (value: any, original: boolean, isNew: boolean = false) {
            let annotations = Reflect.getMetadata('Attribute', target) || {};

            annotations[propertyName] = {
                isDirty: isNew ? false : (annotations[propertyName].originalValue != value),
                newValue: value,
                originalValue: original ? value : (annotations[propertyName].originalValue)
            };
            Reflect.defineMetadata('Attribute', annotations, target);
        };

        let getter = function () {
            return this['_' + propertyName];
        };

        let setter = function (newVal: any) {
            saveAnnotations(newVal, false);
            this['_' + propertyName] = newVal;
        };

        if (delete target[propertyName]) {
            saveAnnotations(undefined, true, true);
            Object.defineProperty(target, propertyName, {
                get: getter,
                set: setter,
                enumerable: true,
                configurable: true
            });
        }
    };
}

export function Relationship() {
    return function (target: any, propertyName: string | symbol) {
        let annotations = Reflect.getMetadata('Relationships', target) || [];
        let targetType = Reflect.getMetadata('design:type', target, propertyName);
        annotations.push({
            propertyName: propertyName,
            relationship: targetType
        });
        Reflect.defineMetadata('Relationships', annotations, target);
    };
}

export interface IResourceConfig {
    type: string;
    uri?: string;
}

export function Resource(config: IResourceConfig) {
    return function (target: any) {
        Reflect.defineMetadata('Resource', config, target);
    };
}

export type ResourceType<T extends BaseResource> = { new (rm: ResourceManager, data?: any, original?: boolean): T; };

export abstract class BaseResource {

    id: string;

    createdAt: string;
    updateAt: string;
    deleteAt: string;

    constructor(protected rm: ResourceManager, data?: any, original: boolean = false) {
        if (data) {
            this.initAttributes(data, original);
        }
    }

    private initAttributes(data: any, original: boolean) {
        this.id = data.id;
        let self: any = this;
        let annotations = Reflect.getMetadata('Attribute', this);
        _.forEach(data.attributes, function (value: any, key: string) {
            if (annotations.hasOwnProperty(key)) {
                self[key] = value;
                
                if (original) {
                    _.extend(annotations[key], {
                        isDirty: false,
                        originalValue: value
                    });
                }
            }
        });
        return this;
    }

    save(): Observable<Response | any> {
        const uri = this.rm.buildUri(this, this.id);
        const headers = this.rm.getHeaders();
        if (this.id)
            return this.rm.http.patch(uri, this.toJsonApi(), { headers: headers })
                .map(res => res.json())
                .map((data) => { return this.initAttributes(data, true); });
        else
            return this.rm.http.post(uri, this.toJsonApi(), { headers: headers })
                .map(res => res.json())
                .map((data) => { return this.initAttributes(data, true); });
    }

    remove(): Observable<Response | any> {
        const uri = this.rm.buildUri(this, this.id);
        const headers = this.rm.getHeaders();
        return this.rm.http.delete(uri, { headers: headers })
            .map(res => res.json())
            .map((data) => { return this.initAttributes(data, true); });
    }

    isDirty(): boolean {
        let dirty = false;
        const annotations = Reflect.getMetadata('Attribute', this);
        for (let i in annotations) {
            const value = annotations[i];
            if (_.get(value, 'isDirty')) {
                dirty = true;
                break;
            }
        }
        return dirty;
    }

    toJsonApi() {
        let self: any = this;
        const resourceMeta = Reflect.getMetadata('Resource', this.constructor);
        const annotations = Reflect.getMetadata('Attribute', this);
        let data = {
            type: resourceMeta.type,
            attributes: {}
        };
        if (this.id) {
            _.set(data, 'id', this.id);
        }
        _.each(annotations, function (value: any, key: string) {
            if (_.get(value, 'isDirty')) {
                _.set(data.attributes, key, self[key]);
            }
        });
        return { data: data };
    }
}

export class ValueObject {

    equalTo<T extends ValueObject>(object: T): boolean {
        return true;
    }
}

export class QueryBuilder {

    private _fields: string[] = [];
    private _sorts: string[] = [];
    private _filters: string[] = [];
    private _pageSize: number;
    private _pageNumber: number;

    constructor(private resource: any, private rm: ResourceManager) {
    }

    fields(...args: string[]): QueryBuilder {
        this._fields = args;
        return this;
    }

    sortBy(...args: string[]): QueryBuilder {
        this._sorts = args;
        return this;
    }

    filters(...args: string[]): QueryBuilder {
        this._filters = args;
        return this;
    }

    limit(v: number): QueryBuilder {
        this._pageSize = v;
        return this;
    }

    page(v: number): QueryBuilder {
        this._pageNumber = v;
        return this;
    }

    private isAttribute(v: string): boolean {
        const attributesMetadata = Reflect.getMetadata('Attribute', new this.resource);
        return attributesMetadata.hasOwnProperty(v);
    }

    private validateAttributes() {
        const sortFields = this._sorts.reduce((pv: string[], cv: string) => {
            pv.push((cv[0] === '-') ? (cv.substr(1, cv.length)) : cv);
            return pv;
        }, []);
        const fields = this._fields.concat(this._filters, sortFields);
        for (let f of fields) {
            if (!this.isAttribute(f)) {
                console.warn(`The attribute ${f} is not part of resource`);
            }
        }
    }

    private buildParameters(): string {
        let params: string[] = [];

        if (this._pageSize) {
            params.push(`page[size]=${this._pageSize}`);
        }
        if (this._pageNumber) {
            params.push(`page[number]=${this._pageNumber}`);
        }

        this.validateAttributes();

        if (this._fields.length) {
            params.push(`fields=${this._fields.join(',')}`);
        }

        if (this._filters.length) {
            params.push(`filter=${this._filters.join(',')}`);
        }

        if (this._sorts.length) {
            params.push(`sort=${this._sorts.join(',')}`);
        }

        return params.join('&');
    }

    execute(id?: string): Observable<any> {
        // setting properly header for json-api

        const headers = this.rm.getHeaders();

        const uri = this.rm.buildUri(new this.resource, id);
        return this.rm.http
            .get(uri, { search: this.buildParameters(), headers: headers })
            .map(res => res.json())
            .map((data) => {
                return {
                    data: this.rm.extractQueryData(data, this.resource),
                    meta: _.get(data, 'meta')
                }
            });
    }
}

@Injectable()
export class ResourceManager {
    apiUrl: string = 'http://localhost:8000/'

    constructor(public http: Http) {
    }

    from<T extends BaseResource>(r: ResourceType<T>): QueryBuilder {
        return new QueryBuilder(r, this);
    }

    buildUri(resource: any, id?: string): string {
        const resourceMetadata = Reflect.getMetadata('Resource', resource.constructor);
        let apiPath = this.apiUrl;
        const resourceUri = _.get(resourceMetadata, 'uri') ? _.get(resourceMetadata, 'uri') : resourceMetadata.type;
        apiPath += apiPath[apiPath.length - 1] === '/' ? resourceUri : `/${resourceUri}`;
        return id ? `${apiPath}\\${id}` : apiPath;
    }

    extractQueryData<T extends BaseResource>(body: any, modelType: ResourceType<T>): T[] {
        let models: T[] = [];
        body.data.forEach((data: any) => {
            let model: T = new modelType(this, data, true);
            /*if (body.included) {
                model.syncRelationships(data, body.included, 0);
                this.addToStore(model);
            }*/
            models.push(model);
        });
        return models;
    }

    getHeaders() {
        let headers = new Headers();
        headers.append('Content-Type', 'application/vnd.api+json');
        headers.append('Accept', 'application/vnd.api+json');
        return headers;
    }
}

/**
 * Module for angular-jsonapi
 * @experimental
 */
@NgModule({
    imports: [HttpModule],
    providers: [ResourceManager]
})
export class JsonApiModule {
    constructor( @Optional() @SkipSelf() parentModule: JsonApiModule) {
        if (parentModule) {
            throw new Error(
                'JsonApiModule is already loaded. Import it in the AppModule only');
        }
    }

    static forRoot(config: any): ModuleWithProviders {
        return {
            ngModule: JsonApiModule,
            providers: [
                { provide: ResourceManager, useValue: config }
            ]
        };
    }
}
