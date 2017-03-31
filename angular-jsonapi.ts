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
import {Observable} from 'rxjs/Observable';
import 'rxjs/add/operator/map';
import 'rxjs/add/observable/of';
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

export function Relationship(relationsipConstructor: Function) {
    return function (target: any, propertyName: string | symbol) {
        let annotations = Reflect.getMetadata('Relationships', target) || [];
        let targetType = Reflect.getMetadata('design:type', target, propertyName);
        annotations.push({
            propertyName: propertyName,
            relationship: targetType,
            relationsipConstructor: relationsipConstructor
        });
        Reflect.defineMetadata('Relationships', annotations, target);
        if (!_.get(target, propertyName)) {
            Object.defineProperty(target, propertyName as string, {
                value: [],
                enumerable: true,
                configurable: true
            });
        }
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
            if (data.attributes)
                this.initAttributes(data, original);
            else
            // when create a new resource from app
                this.initAttributes({attributes: data, id: data.id}, original);
        }
    }

    initAttributes(data: any, original: boolean) {
        this.id = data.id;
        let self: any = this;
        let annotations = Reflect.getMetadata('Attribute', this);
        _.forEach(data.attributes, function (value: any, key: string) {
            if (_.get(annotations, key)) {
                self[key] = value;

                if (original) {
                    _.extend(annotations[key], {
                        isDirty: false,
                        originalValue: value
                    });
                }
            }
        });


        // let relationships = Reflect.getMetadata('Relationships', this) || [];
        // _.forEach(relationships, (item: any) => {
        //     let propertyName: string = item['propertyName'];
        //     debugger;
        //     if (propertyName && !_.get(self, propertyName)) {
        //         Object.defineProperty(self, propertyName, {
        //             value: [],
        //             enumerable: true,
        //             configurable: true
        //         });
        //     }
        // });
        return this;
    }

    save(relationShip: string[] = []): Observable<Response | any> {
        const uri = this.rm.buildUri(this, this.id);
        const headers = this.rm.getHeaders();
        if (this.id)
            return this.rm.http.patch(uri, this.toJsonApi(relationShip), {headers: headers})
                .map(res => res.json())
                .map((data) => {
                    return this.initAttributes(data, true);
                });
        else
            return this.rm.http.post(uri, this.toJsonApi(relationShip), {headers: headers})
                .map(res => res.json())
                .map((data) => {
                    return this.initAttributes(data, true);
                });
    }

    remove(): Observable<Response | any> {
        const uri = this.rm.buildUri(this, this.id);
        const headers = this.rm.getHeaders();
        return this.rm.http.delete(uri, {headers: headers})
            .map(res => res.json())
            .map((data) => {
                return this.initAttributes(data.data, true);
            });
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

    /**
     * Return a resource un json-api format
     * @param relationShip resources that has a relationship with this resource
     * @returns {{data: {type, attributes: {}}}}
     */
    toJsonApi(relationShips: string[] = []) {
        let self: any = this;
        const resourceMeta = Reflect.getMetadata('Resource', this.constructor);
        const annotations = Reflect.getMetadata('Attribute', this);
        let data = {
            type: resourceMeta.type,
            attributes: {},
            relationships: {}
        };
        if (this.id) {
            _.set(data, 'id', this.id);
        }
        _.each(annotations, function (value: any, key: string) {
            if (_.get(value, 'isDirty')) {
                _.set(data.attributes, key, self[key]);
            }
        });

        if (relationShips.length) {

            const relationshipsMetaData = Reflect.getMetadata('Relationships', this);
            _.each(relationShips, (value: any) => {
                let typeResource = value.type;
                let index = relationshipsMetaData.findIndex((item: any) => item.propertyName == typeResource)

                if (index != -1) {
                    let relation: any[] = [];
                    _.each(value.data, (id: any) => {
                        relation.push({type: typeResource, id: id})
                    });
                    _.set(data.relationships, typeResource, {data: relation});
                }
            });

            if (!_.keys(data.relationships).length)
                delete data.relationships;
        } else {
            delete data.relationships;
        }
        return {data: data};
    }

    syncRelationships(includedData: any[]) {
        let self: any = this;
        let annotations = Reflect.getMetadata('Relationships', this) || [];

        _.forEach(includedData, (value: any) => {
            let type = _.get(value, 'type');
            if (type) {
                // if current resource have this relationship defined
                let relationshipObject = annotations.find((item: any) => item['propertyName'] === type);
                if (relationshipObject) {
                    debugger;
                    console.log(_.get(self, type));
                }
            }
        });
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

    execute(id?: string, queryParams?: any): Observable<any> {
        // setting properly header for json-api

        const headers = this.rm.getHeaders();

        const uri = this.rm.buildUri(new this.resource, id, queryParams);
        return this.rm.http
            .get(uri, {search: this.buildParameters(), headers: headers})
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
    apiUrl: string = 'http://localhost:8000/';

    constructor(public http: Http) {
    }

    from<T extends BaseResource>(r: ResourceType<T>): QueryBuilder {
        return new QueryBuilder(r, this);
    }

    buildUri(resource: any, id?: string, queryParams?: any): string {
        const resourceMetadata = Reflect.getMetadata('Resource', resource.constructor);
        let apiPath = this.apiUrl;
        const resourceUri = _.get(resourceMetadata, 'uri') ? _.get(resourceMetadata, 'uri') : resourceMetadata.type;
        apiPath += apiPath[apiPath.length - 1] === '/' ? resourceUri : `/${resourceUri}`;
        let params: string = '?';
        if (_.keys(queryParams).length) {
            _.each(queryParams, (value: any, key: string) => {
                params += encodeURIComponent(key) + "=" + encodeURIComponent(value) + "&";
            });
            params = params.substring(0, params.length - 1);
            return id ? `${apiPath}\\${id}${params}` : `apiPath${params}`;

        } else {
            return id ? `${apiPath}\\${id}` : apiPath;
        }
    }

    extractQueryData<T extends BaseResource>(body: any, modelType: ResourceType<T>): T[] | T {
        let models: T[] = [];

        if (_.isArray(body.data)) {
            body.data.forEach((data: any, index: number) => {
                let model: T = new modelType(this, data, true);
                // if (body.included && data.relationships) {
                //     model.syncRelationships(data.relationships, body.included, index);
                // }
                models.push(model);
            });
        } else {
            let model = new modelType(this, body.data, true);
            if (body.included && _.isArray(body.included))
                model.syncRelationships(body.included);
            return model;
        }
        return models;
    }

    getHeaders() {
        let headers = new Headers();
        headers.append('Content-Type', 'application/vnd.api+json');
        headers.append('Accept', 'application/vnd.api+json');
        return headers;
    }

    saveCollection<T extends BaseResource>(resources: T[]): Observable<any> {
        let data: any[] = [];
        let dataUri: any[] = [];
        const headers = this.getHeaders();

        _.each(resources, (resource: any) => {
            dataUri.push(resource.rm.buildUri(resource, resource.id));
            data.push(resource.toJsonApi().data);
        });

        // Structure to create several resources
        const jsonApiStructure = {
            data: data
        };

        return this.http.post(dataUri[0], jsonApiStructure, {headers: headers})
            .map(res => res.json())
            .map((data) => {
                return this.initAttributesCollection(resources, data, true);
            });
    }

    initAttributesCollection<T extends BaseResource>(resources: T[], dataResources: any, original: boolean): T[] {
        let models: T[] = [];
        for (let i = 0; i < resources.length; i++)
            models.push(resources[i].initAttributes(dataResources.data[i], original));
        return models;
    }
}

@Injectable()
export class ResourceCollection {
    constructor(public http: Http) {
    }

    save<T extends BaseResource>(resources: T[]): void {
        // create structure for json-api
        _.each(resources, (resource: any, key: string) => {
        });
        // return Observable.of([{one:1,two:2}]);
    }
}

/**
 * Module for angular-jsonapi
 * @experimental
 */
@NgModule({
    imports: [HttpModule],
    providers: [ResourceManager, ResourceCollection]
})
export class JsonApiModule {
    constructor(@Optional() @SkipSelf() parentModule: JsonApiModule) {
        if (parentModule) {
            throw new Error(
                'JsonApiModule is already loaded. Import it in the AppModule only');
        }
    }

    static forRoot(config: any): ModuleWithProviders {
        return {
            ngModule: JsonApiModule,
            providers: [
                {provide: ResourceManager, useValue: config},
                {provide: ResourceCollection, useValue: config}
            ]
        };
    }
}
